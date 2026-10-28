import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import { expandHome } from "./config.js";
import { assertSuccess, runProcess } from "./process.js";
import type { GitHubAppAuth } from "./github/auth.js";

export interface WorkspaceInfo {
  repository: string;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  /** The ref the branch was actually cut from (`origin/<baseBranch>`, or the remote's
   *  default branch via `origin/HEAD` when that branch doesn't exist; `origin/master`
   *  only as a last resort). */
  baseRef: string;
  /**
   * Branch name the PR should target: the integration branch when it exists
   * on the remote, otherwise the fallback the worktree was actually cut from
   * (`master`). PRs cannot target branches that don't exist on the remote —
   * GitHub rejects them with 422 `base: invalid` — and `baseBranch` may be
   * a locally auto-generated `feature/<issue>-<slug>` name that was never
   * pushed. (Regression since 7ef466d: standalone issues dispatched without
   * `--integration-branch` 422'd at PR creation and fell back to manual
   * recovery.)
   */
  prBaseBranch: string;
}

/** Strip the `origin/` prefix from a base ref for PR creation. */

/**
 * Per-repo serialization of `WorkspaceManager.prepare` (module-level: every
 * `runWork` call constructs its own manager, so this map is the only shared
 * handle between concurrently-running workers).
 *
 * `prepare` runs `clone`/`fetch --prune`/`worktree add` against the SHARED
 * `repositories/<repo>` checkout. Two prepares for the same repo running
 * concurrently (daemon fan-out with globalConcurrency > 1) interleave a
 * fetch/prune with a worktree checkout of a ref whose objects the fetch is
 * busy updating — observed 2026-10-28: three pizza-eagle workers at once,
 * `worktree add` failed `fatal: unable to read tree (<sha>)` and the whole
 * run phase crashed. git's own command-level locking can't serialize a
 * multi-command sequence, so the sequence is queued per repo here.
 *
 * Cross-PROCESS races (a manual `work` run beside the daemon) are unchanged
 * by this — same exposure as before globalConcurrency was enforced.
 */
const repoPrepareQueues = new Map<string, Promise<unknown>>();
/**
 * Fallback when the configured/auto-generated base branch isn't on the remote:
 * resolve the repo's actual default branch via `origin/HEAD` (set by clone)
 * instead of assuming master. pizza-eagle is main-based and the hardcoded
 * `origin/master` fallback failed worktree creation with
 * `fatal: invalid reference: origin/master` (2026-10-28). The final fallback
 * preserves the legacy master assumption when origin/HEAD can't be resolved.
 */
async function defaultRemoteBranch(
  repositoryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const head = await runProcess(
    "git",
    [
      "-C",
      repositoryPath,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ],
    { env },
  );
  const ref = head.stdout.trim();
  return head.exitCode === 0 && ref.startsWith("origin/")
    ? ref
    : "origin/master";
}

export const prBaseBranchForRef = (baseRef: string): string =>
  baseRef.replace(/^origin\//, "");

/**
 * Git identity for everything authored inside agent worktrees. The email is
 * the GitHub App bot's noreply address (same identity GitHub stamps on
 * app-token API merges), so code commits match the PR/merge authorship
 * instead of the machine's global git config. Applies to commits made by the
 * orchestrator, executor sessions, and human operators doing manual recovery
 * in a retained worktree.
 */
export const AGENT_GIT_NAME = "democracy-delicious-agent[bot]";
export const AGENT_GIT_EMAIL =
  "313051742+democracy-delicious-agent[bot]@users.noreply.github.com";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(
    private readonly config: AgentConfig,
    private readonly auth: GitHubAppAuth,
  ) {
    this.root = expandHome(config.paths.workspace);
  }

  private async gitAuthEnvironment(): Promise<NodeJS.ProcessEnv> {
    const { token } = await this.auth.getInstallationToken();
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      DD_GITHUB_TOKEN: token,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
  }

  async prepare(
    repository: string,
    issueNumber: number,
    issueTitle: string,
    inputPaths: string[] = [],
    integrationBranch?: string,
  ): Promise<WorkspaceInfo> {
    const repoName = basename(repository);
    // Serialize against other prepares for this repo (see repoPrepareQueues):
    // wait for the current tail, then run; a failed predecessor must not
    // poison the chain, and the tail promise must never reject into the map.
    const previous = repoPrepareQueues.get(repoName) ?? Promise.resolve();
    const run = () =>
      this.prepareUnlocked(
        repository,
        issueNumber,
        issueTitle,
        inputPaths,
        integrationBranch,
      );
    const tail = previous.then(run, run);
    const swallowed = tail.then(
      () => undefined,
      () => undefined,
    );
    repoPrepareQueues.set(repoName, swallowed);
    try {
      return await tail;
    } finally {
      // Our tail settles here; drop it unless someone chained behind us.
      if (repoPrepareQueues.get(repoName) === swallowed)
        repoPrepareQueues.delete(repoName);
    }
  }

  private async prepareUnlocked(
    repository: string,
    issueNumber: number,
    issueTitle: string,
    inputPaths: string[] = [],
    integrationBranch?: string,
  ): Promise<WorkspaceInfo> {
    const repoName = basename(repository);
    const repositoryPath = resolve(this.root, "repositories", repoName);
    const worktreePath = resolve(
      this.root,
      "worktrees",
      repoName,
      `issue-${issueNumber}`,
    );
    const branch = `agent/${issueNumber}-${slugify(issueTitle)}`;
    const baseBranch =
      integrationBranch ?? `feature/${issueNumber}-${slugify(issueTitle)}`;
    await mkdir(resolve(this.root, "repositories"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(resolve(this.root, "worktrees", repoName), {
      recursive: true,
      mode: 0o700,
    });

    const env = await this.gitAuthEnvironment();
    try {
      assertSuccess(
        await runProcess(
          "git",
          ["-C", repositoryPath, "rev-parse", "--git-dir"],
          { env, timeoutMs: 10_000 },
        ),
      );
      assertSuccess(
        await runProcess(
          "git",
          ["-C", repositoryPath, "fetch", "--prune", "origin"],
          { env, timeoutMs: 120_000 },
        ),
      );
    } catch {
      await rm(repositoryPath, { recursive: true, force: true });
      assertSuccess(
        await runProcess(
          "git",
          ["clone", `https://github.com/${repository}.git`, repositoryPath],
          { env, timeoutMs: 180_000 },
        ),
      );
    }

    const remoteFeature = await runProcess(
      "git",
      [
        "-C",
        repositoryPath,
        "show-ref",
        "--verify",
        `refs/remotes/origin/${baseBranch}`,
      ],
      { env },
    );
    const baseRef =
      remoteFeature.exitCode === 0
        ? `origin/${baseBranch}`
        : await defaultRemoteBranch(repositoryPath, env);

    const existingWorktree = await runProcess(
      "git",
      ["-C", worktreePath, "rev-parse", "--show-toplevel"],
      { env },
    );
    if (existingWorktree.exitCode !== 0) {
      await rm(worktreePath, { recursive: true, force: true });
      const localBranch = await runProcess(
        "git",
        ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/${branch}`],
        { env },
      );
      if (localBranch.exitCode === 0) {
        assertSuccess(
          await runProcess(
            "git",
            ["-C", repositoryPath, "worktree", "add", worktreePath, branch],
            { env },
          ),
        );
      } else {
        assertSuccess(
          await runProcess(
            "git",
            [
              "-C",
              repositoryPath,
              "worktree",
              "add",
              "-b",
              branch,
              worktreePath,
              baseRef,
            ],
            { env },
          ),
        );
      }
    }

    if (inputPaths.length) {
      const inputDirectory = resolve(worktreePath, ".agent-inputs");
      await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
      for (const rawPath of inputPaths) {
        const source = isAbsolute(rawPath) ? rawPath : expandHome(rawPath);
        const destination = resolve(inputDirectory, basename(source));
        if (!destination.startsWith(`${inputDirectory}/`))
          throw new Error(`Invalid input path: ${rawPath}`);
        await rm(destination, { force: true });
        await copyFile(source, destination);
        await chmod(destination, 0o444);
      }
      const gitPath = await runProcess(
        "git",
        ["-C", repositoryPath, "rev-parse", "--git-path", "info/exclude"],
        { env },
      );
      assertSuccess(gitPath);
      const excludePath = resolve(repositoryPath, gitPath.stdout.trim());
      const currentExcludes = await readFile(excludePath, "utf8").catch(
        () => "",
      );
      if (!currentExcludes.split("\n").includes(".agent-inputs/")) {
        await appendFile(
          excludePath,
          `${currentExcludes.endsWith("\n") ? "" : "\n"}.agent-inputs/\n`,
        );
      }
    }

    // Pin the worktree clone's commit identity to the agent bot. `git config`
    // in a linked worktree writes the clone's shared config, so this covers
    // every worktree of this clone — including previously created ones that
    // a `--resume` or manual recovery will commit in later.
    assertSuccess(
      await runProcess(
        "git",
        ["-C", worktreePath, "config", "user.name", AGENT_GIT_NAME],
        { env },
      ),
    );
    assertSuccess(
      await runProcess(
        "git",
        ["-C", worktreePath, "config", "user.email", AGENT_GIT_EMAIL],
        { env },
      ),
    );

    return {
      repository,
      repositoryPath,
      worktreePath,
      branch,
      baseBranch,
      baseRef,
      prBaseBranch: prBaseBranchForRef(baseRef),
    };
  }
}
