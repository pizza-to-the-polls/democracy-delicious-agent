import type { AgentConfig } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";
import { expandHome } from "../config.js";
import { runWork } from "./work.js";

/**
 * Auto-discover the next agent:ready issue and work it.
 *
 * Scans approved repositories for issues labeled `agent:ready` that don't
 * already have an open agent PR, picks the oldest, determines the right
 * integration branch, and delegates to the standard `work` pipeline.
 */
export async function runAuto(
  config: AgentConfig,
  options: { repo?: string; dryRun: boolean }
): Promise<number> {
  const keyPath = expandHome(config.paths.githubPrivateKey);
  const auth = new GitHubAppAuth(
    config.github.appId,
    config.github.installationId,
    keyPath
  );
  const client = new GitHubClient(auth);

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
      // Convention: if the issue is on pizzabase, look for feature branch labels
      // or default to the issue's project column / milestone.
      let integrationBranch = "master";

      // Check for explicit integration-branch label (e.g. "branch:feature/exif-endpoint").
      for (const label of issue.labels) {
        if (label.startsWith("branch:")) {
          integrationBranch = label.slice(7);
          break;
        }
      }

      // If no explicit label, try to read from issue body (e.g. a section
      // like "Integration branch: feature/sightengine-review").
      if (integrationBranch === "master" && issue.body) {
        const match = issue.body.match(
          /[Ii]ntegration\s*branch:\s*(\S+)/
        );
        if (match) integrationBranch = match[1];
      }

      // Check if there's already an open PR for this issue.
      // Look for agent branches matching agent/{issueNumber}-*
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

  if (candidates.length === 0) {
    console.log("No agent:ready issues without active PRs. Backlog is clear.");
    return 0;
  }

  // Pick the first candidate (oldest issue, sorted by GitHub default).
  const next = candidates[0];
  console.log(
    `Auto-selected: ${next.repository}#${next.number} — ${next.title}`
  );
  console.log(`Integration branch: ${next.integrationBranch}`);

  return runWork(config, {
    repository: next.repository,
    issueNumber: next.number,
    dryRun: options.dryRun,
    resume: false,
    reviewOnly: false,
    integrationBranch:
      next.integrationBranch !== "master"
        ? next.integrationBranch
        : undefined,
  });
}