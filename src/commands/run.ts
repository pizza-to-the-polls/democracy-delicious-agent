import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentConfig } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";
import { expandHome } from "../config.js";
import { runWork } from "./work.js";
import { StateStore } from "../state.js";

export interface RunAutoDeps {
  client?: GitHubClient;
  store?: StateStore;
  work?: typeof runWork;
  /** Try to acquire an exclusive lock for this issue. Returns true if locked. */
  tryLock?: (repo: string, issue: number) => Promise<boolean>;
  /** Release a previously acquired lock. */
  unlock?: (repo: string, issue: number) => Promise<void>;
}

export interface RunAutoOptions {
  repo?: string;
  dryRun: boolean;
  /** Max issues to work concurrently (default 1 — the pre-parallel behavior). */
  maxParallel?: number;
}

/**
 * Auto-discover the next agent:ready issue and work it.
 *
 * Scans approved repositories for issues labeled `agent:ready` that don't
 * already have an open agent PR, picks the oldest, determines the right
 * integration branch, acquires an exclusive lock, and delegates to the
 * standard `work` pipeline. If locking fails, the next candidate is tried.
 *
 * With `maxParallel > 1` the same selection runs for up to that many
 * lockable candidates and their `work` pipelines run concurrently —
 * per-issue locks still serialize any two workers on the same issue across
 * daemons and manual `work` runs, and each issue gets its own worktree,
 * branch, state file, and test database, so the only shared resources are
 * the append-only timeline log and the (non-binding) global budget.
 */
export async function runAuto(
  config: AgentConfig,
  options: RunAutoOptions,
  deps: RunAutoDeps = {},
): Promise<number> {
  const client =
    deps.client ??
    (() => {
      const keyPath = expandHome(config.paths.githubPrivateKey);
      const auth = new GitHubAppAuth(
        config.github.appId,
        config.github.installationId,
        keyPath,
      );
      return new GitHubClient(auth);
    })();

  const repos = options.repo
    ? [options.repo]
    : config.github.repositories.filter(
        (r) => r !== "pizza-to-the-polls/democracy-delicious-agent",
      );

  // Collect all agent:ready issues across repos.
  const candidates: Array<{
    repository: string;
    number: number;
    title: string;
    integrationBranch: string;
  }> = [];

  for (const repo of repos) {
    // Fetch open PRs once per repo (not per issue) to avoid N+1 API calls.
    const openPRs = await client.listOpenPullRequests(repo);
    // Search issues with agent:ready label.
    const issues = await client.searchIssues(repo, ["agent:ready"]);
    for (const issue of issues) {
      // Determine the integration branch from issue labels or body hints.
      let integrationBranch = "master";

      for (const label of issue.labels) {
        if (label.startsWith("branch:")) {
          integrationBranch = label.slice(7);
          break;
        }
      }

      if (integrationBranch === "master" && issue.body) {
        const match = issue.body.match(/[Ii]ntegration\s*branch:\s*(\S+)/);
        if (match) integrationBranch = match[1];
      }

      // Check if there's already an open PR for this issue.
      const alreadyWorking = openPRs.some(
        (pr) =>
          pr.headRefName.startsWith(`agent/${issue.number}-`) ||
          (pr.title.includes(`#${issue.number}`) &&
            pr.title.includes(issue.title.slice(0, 20))),
      );
      if (alreadyWorking) continue; // Skip — already being worked.

      candidates.push({
        repository: repo,
        number: issue.number,
        title: issue.title,
        integrationBranch,
      });
    }
  }

  const maxParallel = Math.max(1, options.maxParallel ?? 1);

  // Try each candidate in order; skip any we can't lock, until maxParallel
  // issues are locked and their pipelines launched.
  const lockFn = deps.tryLock ?? defaultTryLock(config);
  const unlockFn = deps.unlock ?? defaultUnlock(config);
  const store = deps.store ?? new StateStore(config);
  const workFn = deps.work ?? runWork;

  const launched: Array<() => Promise<number>> = [];
  for (const candidate of candidates) {
    if (launched.length >= maxParallel) break;

    if (options.dryRun) {
      console.log(
        `Would work: ${candidate.repository}#${candidate.number} — ${candidate.title}`,
      );
      console.log(`Integration branch: ${candidate.integrationBranch}`);
      continue;
    }

    // ---- Locking ----
    const locked = await lockFn(candidate.repository, candidate.number);
    if (!locked) {
      console.log(`Skipping #${candidate.number} — locked by another daemon.`);
      continue;
    }

    console.log(
      `Auto-selected: ${candidate.repository}#${candidate.number} — ${candidate.title}`,
    );
    console.log(`Integration branch: ${candidate.integrationBranch}`);

    // Check for existing state — auto-resume if work was already started.
    const state = await store.load(candidate.repository, candidate.number);

    // Skip already-reviewed issues — they're done. Release the lock first:
    // holding it past the skip leaks the lock until this process exits
    // (the same-pid stale-lock reclaim can't take it back).
    if (state && state.phase === "reviewed") {
      console.log(`Skipping #${candidate.number} — already reviewed.`);
      await unlockFn(candidate.repository, candidate.number).catch(() => {});
      continue;
    }

    const resume = !!(state && state.phase !== "created");
    if (resume) console.log(`Resuming (phase: ${state.phase})…`);

    launched.push(() =>
      workFn(config, {
        repository: candidate.repository,
        issueNumber: candidate.number,
        dryRun: false,
        resume,
        reviewOnly: false,
        integrationBranch:
          candidate.integrationBranch !== "master"
            ? candidate.integrationBranch
            : undefined,
      }).finally(() => {
        // Always release the lock when work finishes or fails.
        unlockFn(candidate.repository, candidate.number).catch(() => {});
      }),
    );
  }

  if (options.dryRun) {
    if (candidates.length > 0) {
      console.log("Dry run — stopping before agent execution.");
    } else {
      console.log(
        "No agent:ready issues without active PRs that we can lock. Backlog is clear.",
      );
    }
    return 0;
  }

  if (launched.length === 0) {
    console.log(
      "No agent:ready issues without active PRs that we can lock. Backlog is clear.",
    );
    return 0;
  }

  // Fan out: up to maxParallel work pipelines concurrently. Exit code is
  // aggregated — any failed worker marks the phase failed for the timeline.
  const results = await Promise.all(launched.map((start) => start()));
  return results.every((code) => code === 0) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Default file-based locking (single-machine, multi-process safe)
// ---------------------------------------------------------------------------

function lockPath(
  config: AgentConfig,
  repository: string,
  issueNumber: string | number,
): string {
  return resolve(
    expandHome(config.paths.workspace),
    "locks",
    `${String(repository).replace("/", "--")}-${issueNumber}.lock`,
  );
}

/** Best-effort liveness check: a dead holder's lock can be taken over. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user — treat as alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLockFile(path: string): Promise<boolean> {
  try {
    // wx = exclusive write, fails with EEXIST if lock already held
    await writeFile(path, `${process.pid}\n${new Date().toISOString()}`, {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

export function defaultTryLock(config: AgentConfig) {
  return async (repository: string, issueNumber: number): Promise<boolean> => {
    const path = lockPath(config, repository, issueNumber);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    if (await acquireLockFile(path)) return true;

    // Lock exists — check whether the holder is still alive. A crashed daemon
    // leaves a stale lock behind; reclaim it instead of skipping the issue forever.
    try {
      const content = await readFile(path, "utf8");
      const pid = Number.parseInt(content.split("\n")[0] ?? "", 10);
      if (Number.isFinite(pid) && pid !== process.pid && !processAlive(pid)) {
        console.log(`Reclaiming stale lock ${path} (pid ${pid} is gone).`);
        await rm(path, { force: true });
        return acquireLockFile(path);
      }
    } catch {
      // Lock vanished between the failed acquire and the read — try once more.
      return acquireLockFile(path);
    }
    return false;
  };
}

export function defaultUnlock(config: AgentConfig) {
  return async (repository: string, issueNumber: number): Promise<void> => {
    try {
      await rm(lockPath(config, repository, issueNumber), { force: true });
    } catch {
      // Lock file already gone — no problem.
    }
  };
}
