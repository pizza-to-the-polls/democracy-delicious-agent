import { appendFile, chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
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
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(private readonly config: AgentConfig, private readonly auth: GitHubAppAuth) {
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

  async prepare(repository: string, issueNumber: number, issueTitle: string, inputPaths: string[] = []): Promise<WorkspaceInfo> {
    const repoName = basename(repository);
    const repositoryPath = resolve(this.root, "repositories", repoName);
    const worktreePath = resolve(this.root, "worktrees", repoName, `issue-${issueNumber}`);
    const branch = `agent/${issueNumber}-${slugify(issueTitle)}`;
    const baseBranch = `feature/${issueNumber}-${slugify(issueTitle)}`;
    await mkdir(resolve(this.root, "repositories"), { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.root, "worktrees", repoName), { recursive: true, mode: 0o700 });

    const env = await this.gitAuthEnvironment();
    try {
      assertSuccess(await runProcess("git", ["-C", repositoryPath, "rev-parse", "--git-dir"], { env, timeoutMs: 10_000 }));
      assertSuccess(await runProcess("git", ["-C", repositoryPath, "fetch", "--prune", "origin"], { env, timeoutMs: 120_000 }));
    } catch {
      await rm(repositoryPath, { recursive: true, force: true });
      assertSuccess(await runProcess("git", ["clone", `https://github.com/${repository}.git`, repositoryPath], { env, timeoutMs: 180_000 }));
    }

    const remoteFeature = await runProcess("git", ["-C", repositoryPath, "show-ref", "--verify", `refs/remotes/origin/${baseBranch}`], { env });
    const baseRef = remoteFeature.exitCode === 0 ? `origin/${baseBranch}` : "origin/master";

    const existingWorktree = await runProcess("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"], { env });
    if (existingWorktree.exitCode !== 0) {
      await rm(worktreePath, { recursive: true, force: true });
      const localBranch = await runProcess("git", ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/${branch}`], { env });
      if (localBranch.exitCode === 0) {
        assertSuccess(await runProcess("git", ["-C", repositoryPath, "worktree", "add", worktreePath, branch], { env }));
      } else {
        assertSuccess(await runProcess("git", ["-C", repositoryPath, "worktree", "add", "-b", branch, worktreePath, baseRef], { env }));
      }
    }

    if (inputPaths.length) {
      const inputDirectory = resolve(worktreePath, ".agent-inputs");
      await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
      for (const rawPath of inputPaths) {
        const source = isAbsolute(rawPath) ? rawPath : expandHome(rawPath);
        const destination = resolve(inputDirectory, basename(source));
        if (!destination.startsWith(`${inputDirectory}/`)) throw new Error(`Invalid input path: ${rawPath}`);
        await copyFile(source, destination);
        await chmod(destination, 0o444);
      }
      const gitPath = await runProcess("git", ["-C", repositoryPath, "rev-parse", "--git-path", "info/exclude"], { env });
      assertSuccess(gitPath);
      const excludePath = resolve(repositoryPath, gitPath.stdout.trim());
      const currentExcludes = await readFile(excludePath, "utf8").catch(() => "");
      if (!currentExcludes.split("\n").includes(".agent-inputs/")) {
        await appendFile(excludePath, `${currentExcludes.endsWith("\n") ? "" : "\n"}.agent-inputs/\n`);
      }
    }

    return { repository, repositoryPath, worktreePath, branch, baseBranch };
  }
}
