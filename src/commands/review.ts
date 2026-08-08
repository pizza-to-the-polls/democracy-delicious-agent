/**
 * Autonomous PR review command.
 *
 * Finds open agent PRs targeting integration branches, runs independent
 * review via the reviewer model, posts findings as PR comments, and
 * merges when review passes and CI is green.
 */

import type { AgentConfig } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";
import { expandHome } from "../config.js";
import { runAgentSession } from "../agent/run-session.js";
import { getOpenRouterUsage, assertBudgetAvailable } from "../budget.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EligiblePR {
  repository: string;
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  html_url: string;
  ciPassed: boolean;
  hasHumanComments: boolean;
}

interface ReviewDecision {
  accepted: boolean;
  merged: boolean;
  commentUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reviewAccepted(text: string): boolean {
  return /\bVERDICT:\s*ACCEPT\b/i.test(text) && !/\bVERDICT:\s*REJECT\b/i.test(text);
}

const REVIEW_PROMPT = `You are an autonomous code reviewer. Review this pull request thoroughly. Be skeptical. After your analysis, end with exactly VERDICT: ACCEPT or VERDICT: REJECT.

Check for:
- Correctness: does the code implement what the issue describes?
- Test quality: are tests present, not skipped, and testing real behavior?
- Architecture: are controllers thin? Is logic extracted into services with DI?
- Type safety: are interfaces well-typed without being brittle?
- Formatting: was the project's fix/lint command run?
- Coding standards: no skipped tests on new features, clean interfaces, thin controllers.

If you reject, list specific, actionable findings.`;

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runReview(config: AgentConfig, options: {
  dryRun: boolean;
  repo?: string;
}): Promise<number> {
  const usage = await getOpenRouterUsage();
  assertBudgetAvailable(usage, config.budget, 0.5);
  console.log(`OpenRouter: $${usage.usage.toFixed(2)} used, $${usage.remaining?.toFixed(2) ?? "?"} remaining`);

  const keyPath = expandHome(config.paths.githubPrivateKey);
  const auth = new GitHubAppAuth(config.github.appId, config.github.installationId, keyPath);
  const client = new GitHubClient(auth);

  const repos = options.repo
    ? [options.repo]
    : config.github.repositories.filter((r) => r !== "pizza-to-the-polls/democracy-delicious-agent");

  // ---- 1. Find eligible PRs ------------------------------------------------
  const eligible: EligiblePR[] = [];

  for (const repo of repos) {
    const prs = await client.listOpenPullRequests(repo);
    for (const pr of prs) {
      // Only agent PRs targeting feature branches.
      if (!pr.headRefName.startsWith("agent/")) continue;
      if (!pr.baseRefName.startsWith("feature/")) continue;

      // Skip if already reviewed by an agent.
      const details = await client.getPullRequest(repo, pr.number);
      const labels = details.labels.map((l: { name: string }) => l.name);
      if (labels.includes("agent:reviewed")) continue;

      // Check CI status.
      const ci = await client.getPullRequestChecks(repo, pr.number);
      const ciPassed = ci.every(
        (c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED"
      );
      console.log(`  PR #${pr.number}: CI ${ciPassed ? "pass" : "FAIL"} (${ci.map((c) => `${c.name}=${c.conclusion ?? "pending"}`).join(", ") || "no checks"})`);

      // Check for human review comments.
      const comments = await client.listPullRequestComments(repo, pr.number);
      const hasHumanComments = comments.some(
        (c) =>
          !c.user.login.includes("bot") &&
          !c.user.login.includes("agent") &&
          !c.user.login.includes("[bot]")
      );

      eligible.push({
        repository: repo,
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        html_url: pr.html_url,
        ciPassed,
        hasHumanComments,
      });
    }
  }

  if (eligible.length === 0) {
    console.log("No eligible agent PRs to review.");
    return 0;
  }

  console.log(`Found ${eligible.length} PR(s) to review:`);

  const decisions: ReviewDecision[] = [];

  for (const pr of eligible) {
    console.log(`\n--- PR #${pr.number}: ${pr.title} ---`);
    console.log(`  URL: ${pr.html_url}`);
    console.log(`  CI: ${pr.ciPassed ? "pass" : "fail"}`);
    console.log(`  Human comments: ${pr.hasHumanComments ? "yes (skip merge)" : "no"}`);

    if (pr.hasHumanComments) {
      console.log("  ⏭ Skipping — has human feedback. Flag for manual review.");
      await client.addPullRequestLabel(pr.repository, pr.number, "agent:needs-human");
      continue;
    }

    if (!pr.ciPassed) {
      console.log("  ⚠ CI failed — flagging for auto-fix.");
      await client.addPullRequestComment(pr.repository, pr.number,
        "## CI failure detected\n\nOne or more CI checks did not pass. An agent will pick this up and attempt a fix."
      );
      await client.addPullRequestLabel(pr.repository, pr.number, "agent:feedback");
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "skip", detail: "CI failed" });
      decisions.push({ accepted: false, merged: false, commentUrl: pr.html_url });
      continue;
    }

    if (options.dryRun) {
      console.log("  Dry run — would review + merge.");
      continue;
    }

    // ---- 2. Run independent review ----------------------------------------
    console.log("  Running independent review…");
    const prDiff = await client.getPullRequestDiff(pr.repository, pr.number);
    const diffSize = prDiff.length;
    const isJson = prDiff.startsWith("{");
    console.log(`  Diff size: ${diffSize} bytes${isJson ? " (WARNING: looks like JSON, not a diff!)" : ""}`);
    if (isJson) {
      console.log("  ⚠ Diff is JSON — Accept header override may be broken. Skipping review.");
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "fail", detail: "diff is JSON, not a diff" });
      continue;
    }

    const reviewer = await runAgentSession({
      config,
      role: "reviewer",
      cwd: process.cwd(),
      prompt: `Review this pull request:\n\n# PR #${pr.number}: ${pr.title}\nBase: ${pr.baseRefName}\nHead: ${pr.headRefName}\n\n# Diff\n${prDiff.slice(0, 24000)}\n\n${REVIEW_PROMPT}`,
      tools: [], // Read-only — the reviewer only inspects the diff.
      systemAppend: "You are an autonomous code reviewer. Be skeptical. Review the diff only.",
      sessionName: `review-pr-${pr.number}`,
    });

    console.log(`  Review cost: $${reviewer.cost.toFixed(4)}`);

    // ---- 3. Post review comment -------------------------------------------
    const commentUrl = await client.addPullRequestComment(
      pr.repository,
      pr.number,
      `## Autonomous review\n\n${reviewer.text}\n\n_— democracy-delicious-agent_`
    );
    console.log(`  Comment: ${commentUrl}`);

    const accepted = reviewAccepted(reviewer.text);
    let merged = accepted && pr.ciPassed;

    // ---- 4. Merge if accepted ---------------------------------------------
    if (merged) {
      console.log("  ✅ Review passed + CI green — merging.");
      try {
        await client.mergePullRequest(pr.repository, pr.number, pr.headRefName);
        await client.addPullRequestLabel(pr.repository, pr.number, "agent:reviewed");
        console.log("  ✅ Merged successfully.");
        await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "ok", detail: "merged" });
        // Update the linked issue label.
        const linkedIssues = await client.getLinkedIssues(pr.repository, pr.number);
        for (const issue of linkedIssues) {
          try {
            await client.removeIssueLabel(pr.repository, issue.number, "agent:in-review");
            await client.addIssueLabel(pr.repository, issue.number, "agent:done");
          } catch { /* non-blocking */ }
        }
      } catch (err) {
        console.log(`  ❌ Merge failed: ${err instanceof Error ? err.message : String(err)}`);
        await client.addPullRequestComment(pr.repository, pr.number,
          `## Merge failed\n\n${err instanceof Error ? err.message : String(err)}\n\n_— democracy-delicious-agent_`
        );
        await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "fail", detail: `merge error: ${err instanceof Error ? err.message : String(err)}` });
        merged = false;
      }
    } else if (accepted && !pr.ciPassed) {
      console.log("  ⚠ Review passed but CI failed — not merging.");
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "skip", detail: "accepted but CI failed" });
    } else {
      console.log("  ❌ Review rejected — see comment for findings.");
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "skip", detail: "review rejected" });
    }

    decisions.push({ accepted, merged, commentUrl });
  }

  // ---- 5. Summary ---------------------------------------------------------
  console.log(`\n=== Review summary ===`);
  console.log(`PRs reviewed: ${decisions.length}`);
  console.log(`Accepted: ${decisions.filter((d) => d.accepted).length}`);
  console.log(`Merged: ${decisions.filter((d) => d.merged).length}`);

  return 0;
}