import { mkdir, writeFile, rm } from "node:fs/promises";
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

/**
 * Auto-discover the next agent:ready issue and work it.
 *
 * Scans approved repositories for issues labeled `agent:ready` that don't
 * already have an open agent PR, picks the oldest, determines the right
 * integration branch, acquires an exclusive lock, and delegates to the
 * standard `work` pipeline. If locking fails, the next candidate is tried.
 */
export async function runAuto(
  config: AgentConfig,
  options: { repo?: string; dryRun: boolean },
  deps: RunAutoDeps = {}
): Promise<number> {
  const client = deps.client ?? (() => {
    const keyPath = expandHome(config.paths.githubPrivateKey);
    const auth = new GitHubAppAuth(
      config.github.appId,
      config.github.installationId,
      keyPath
    );
    return new GitHubClient(auth);
  })();

  const repos = options.repo
    ? [options.repo]
    : config.github.repositories.filter((r) => r !== "pizza-to-the-polls/democracy-delicious-agent");

  // Collect all agent:ready issues across repos.
  const candidates: Array<{
    repository: string;
    number: number;
    title: string;
    integrationBranch: string;
  }> = [];

  for (const repo of repos) {
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
        const match = issue.body.match(
          /[Ii]ntegration\s*branch:\s*(\S+)/
        );
        if (match) integrationBranch = match[1];
      }

      // Check if there's already an open PR for this issue.
      const openPRs = await client.listOpenPullRequests(repo);
      const alreadyWorking = openPRs.some(
        (pr) =>
          pr.headRefName.startsWith(`agent/${issue.number}-`) ||
          (pr.title.includes(`#${issue.number}`) &&
            pr.title.includes(issue.title.slice(0, 20)))
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

  // Try each candidate in order; skip any we can't lock.
  for (const candidate of candidates) {
    if (options.dryRun) {
      console.log(
        `Would work: ${candidate.repository}#${candidate.number} — ${candidate.title}`
      );
      console.log(`Integration branch: ${candidate.integrationBranch}`);
      console.log("Dry run — stopping before agent execution.");
      return 0;
    }

    // ---- Locking ----
    const lockFn = deps.tryLock ?? defaultTryLock(config);
    const unlockFn = deps.unlock ?? defaultUnlock(config);
    const locked = await lockFn(candidate.repository, candidate.number);
    if (!locked) {
      console.log(`Skipping #${candidate.number} — locked by another daemon.`);
      continue;
    }

    console.log(
      `Auto-selected: ${candidate.repository}#${candidate.number} — ${candidate.title}`
    );
    console.log(`Integration branch: ${candidate.integrationBranch}`);

    // Check for existing state — auto-resume if work was already started.
    const store = deps.store ?? new StateStore(config);
    const state = await store.load(candidate.repository, candidate.number);

    // Skip already-reviewed issues — they're done.
    if (state && state.phase === "reviewed") {
      console.log(`Skipping #${candidate.number} — already reviewed.`);
      continue;
    }

    const resume = !!(state && state.phase !== "created");
    if (resume) console.log(`Resuming (phase: ${state.phase})…`);

    const workFn = deps.work ?? runWork;
    try {
      return await workFn(config, {
        repository: candidate.repository,
        issueNumber: candidate.number,
        dryRun: false,
        resume,
        reviewOnly: false,
        integrationBranch:
          candidate.integrationBranch !== "master"
            ? candidate.integrationBranch
            : undefined,
      });
    } finally {
      // Always release the lock when work finishes or fails.
      await unlockFn(candidate.repository, candidate.number).catch(() => {});
    }
  }

  console.log("No agent:ready issues without active PRs that we can lock. Backlog is clear.");
  return 0;
}

// ---------------------------------------------------------------------------
// Default file-based locking (single-machine, multi-process safe)
// ---------------------------------------------------------------------------

function lockPath(config: AgentConfig, repository: string, issueNumber: number): string {
  return resolve(expandHome(config.paths.workspace), "locks", `${repository.replace("/", "--")}-${issueNumber}.lock`);
}

function defaultTryLock(config: AgentConfig) {
  return async (repository: string, issueNumber: number): Promise<boolean> => {
    const path = lockPath(config, repository, issueNumber);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    try {
      // wx = exclusive write, fails with EEXIST if lock already held
      await writeFile(path, `${process.pid}\n${new Date().toISOString()}`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
}

function defaultUnlock(config: AgentConfig) {
  return async (repository: string, issueNumber: number): Promise<void> => {
    try {
      await rm(lockPath(config, repository, issueNumber), { force: true });
    } catch {
      // Lock file already gone — no problem.
    }
  };
}