/**
 * Autonomous PR review command.
 *
 * Finds open agent PRs targeting integration branches, runs independent
 * review via the reviewer model, posts findings as PR comments, and
 * merges when review passes and CI is green.
 *
 * Explicit-PR mode (`--pr N --repo owner/name`): review ONE PR by number,
 * bypassing the agent/*→feature/* filter — for PRs that target a default
 * branch directly (e.g. pizza-eagle, where merge-to-main IS the deploy
 * gate). NEVER merges in this mode: the human merge stays the gate.
 */

import type { AgentConfig } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";
import { expandHome } from "../config.js";
import { runAgentSession } from "../agent/run-session.js";
import { getOpenRouterUsage, assertBudgetAvailable } from "../budget.js";
import { notifyBudgetWarning } from "../notifications.js";
import { logTimeline } from "../timeline.js";

// ---------------------------------------------------------------------------
// CI check classification + pending polling
// ---------------------------------------------------------------------------

export interface CheckRun {
  name: string;
  conclusion: string | null;
  status: string;
}

/** Conclusions are normalized to uppercase by the caller.
 * `passed`: every check concluded SUCCESS/NEUTRAL/SKIPPED (vacuously true when
 * a PR has no checks). `pending`: at least one check has not concluded yet —
 * NOT a failure; it means the run is still in progress. */
export function classifyChecks(ci: CheckRun[]): { passed: boolean; pending: boolean } {
  return {
    passed: ci.every((c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED"),
    pending: ci.some((c) => c.conclusion === null),
  };
}

const CI_POLL_INTERVAL_MS = 30_000;
const CI_POLL_MAX_MS = 10 * 60_000;

/** Wait for check-runs to conclude instead of misreading in-progress CI as a
 * failure (which used to file spurious auto-fix issues). Bounded; the caller
 * re-checks classification after. */
async function awaitChecksConcluded(client: GitHubClient, repository: string, number: number): Promise<CheckRun[]> {
  const startedAt = Date.now();
  let ci = (await client.getPullRequestChecks(repository, number)).map(normalizeCheck);
  while (ci.some((c) => c.conclusion === null) && Date.now() - startedAt < CI_POLL_MAX_MS) {
    await new Promise((resolve) => setTimeout(resolve, CI_POLL_INTERVAL_MS));
    ci = (await client.getPullRequestChecks(repository, number)).map(normalizeCheck);
  }
  return ci;
}

function normalizeCheck(c: { name: string; conclusion: string | null; status: string }): CheckRun {
  return { ...c, conclusion: c.conclusion?.toUpperCase() ?? null };
}

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
  body: string | null;
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

/** Explicit-PR mode NEVER merges — for default-branch-targeting PRs the
 * human merge IS the deploy gate, so an accepted review only labels. */
export function shouldAutoMerge(opts: { accepted: boolean; ciPassed: boolean; explicitPr: boolean }): boolean {
  return opts.accepted && opts.ciPassed && !opts.explicitPr;
}

/** Validate --pr/--repo as an explicit review target. The repo must be in
 * the agent's configured fleet — explicit mode broadens WHICH PR in a repo
 * is reviewable, not which repos the agent may touch (democracy-delicious-agent
 * itself is deliberately allowed here, unlike the auto loop: the self-review
 * case is the point). Returns { repo } on success, { error } on failure. */
export function resolveExplicitTarget(
  options: { pr?: number; repo?: string },
  configuredRepos: string[],
): { repo?: string; error?: string } {
  if (!Number.isInteger(options.pr) || (options.pr as number) <= 0) {
    return { error: `--pr needs a PR number, got ${JSON.stringify(options.pr)}` };
  }
  if (!options.repo) {
    return { error: "--pr requires --repo <owner/name> (explicit review is per-repo)" };
  }
  if (!configuredRepos.includes(options.repo)) {
    return { error: `repo ${options.repo} is not in the agent's configured repositories` };
  }
  return { repo: options.repo };
}

const REVIEW_PROMPT = `You are an autonomous code reviewer. Review this pull request thoroughly. Be skeptical. After your analysis, end with exactly VERDICT: ACCEPT or VERDICT: REJECT.

Check for:
- Correctness: does the code implement what the PR/issue describes?
- Test quality: are tests present, not skipped, and testing real behavior?
- Architecture: are controllers thin? Is logic extracted into services with DI (where the repo uses that pattern)?
- Type safety: are interfaces well-typed without being brittle?
- Formatting: was the project's fix/lint command run?
- Coding standards: no skipped tests on new features, clean interfaces.

If you reject, list specific, actionable findings.`;

/** Appended in explicit-PR mode: these PRs land on a default branch with no
 * integration umbrella, so standalone-landing safety is the reviewer's job. */
const EXPLICIT_PR_NOTE = `

This PR targets a default branch directly (explicit review — no integration branch). Judge whether it is safe to land standalone; the human merge is the final gate.`;

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runReview(config: AgentConfig, options: {
  dryRun: boolean;
  repo?: string;
  /** Review ONE explicit PR (--pr N --repo owner/name) — never merges. */
  pr?: number;
}): Promise<number> {
  const usage = await getOpenRouterUsage();
  assertBudgetAvailable(usage, config.budget, 0.5);
  console.log(`OpenRouter: $${usage.usage.toFixed(2)} used, $${usage.remaining?.toFixed(2) ?? "?"} remaining`);
  await notifyBudgetWarning(config, usage);

  const keyPath = expandHome(config.paths.githubPrivateKey);
  const auth = new GitHubAppAuth(config.github.appId, config.github.installationId, keyPath);
  const client = new GitHubClient(auth);

  const repos = options.repo
    ? [options.repo]
    : config.github.repositories.filter((r) => r !== "pizza-to-the-polls/democracy-delicious-agent");

  // ---- 1. Find eligible PRs ------------------------------------------------
  const eligible: EligiblePR[] = [];

  if (options.pr) {
    // Explicit-PR mode: ONE PR by number, no branch-shape filter. Same
    // protections still apply (already-reviewed skip, CI polling, human
    // comment detection) — only the selection filter is bypassed.
    const target = resolveExplicitTarget({ pr: options.pr, repo: options.repo }, config.github.repositories);
    if (target.error) {
      console.error(target.error);
      return 1;
    }
    const repo = target.repo as string;
    const details = await client.getPullRequest(repo, options.pr);
    const labels = details.labels.map((l: { name: string }) => l.name);
    if (labels.includes("agent:reviewed")) {
      console.log(`PR #${options.pr} already carries agent:reviewed — nothing to do.`);
      return 0;
    }
    const ci = await awaitChecksConcluded(client, repo, options.pr);
    const { passed: ciPassed, pending: ciPending } = classifyChecks(ci);
    if (ciPending) {
      console.log(`PR #${options.pr}: CI still pending after polling window — re-run later.`);
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: options.pr, status: "skip", detail: "CI pending (explicit PR)" });
      return 0;
    }
    const comments = await client.listPullRequestComments(repo, options.pr);
    eligible.push({
      repository: repo,
      number: options.pr,
      title: details.title,
      headRefName: details.headRefName,
      baseRefName: details.baseRefName,
      html_url: details.html_url,
      body: details.body,
      ciPassed,
      hasHumanComments: comments.some(
        (c) =>
          !c.user.login.includes("bot") &&
          !c.user.login.includes("agent") &&
          !c.user.login.includes("[bot]"),
      ),
    });
  } else {
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

      // Check CI status. Pending runs are polled to conclusion (bounded) so
      // in-progress CI is never misread as a failure.
      const ci = await awaitChecksConcluded(client, repo, pr.number);
      const { passed: ciPassed, pending: ciPending } = classifyChecks(ci);
      console.log(`  PR #${pr.number}: CI ${ciPending ? "pending" : ciPassed ? "pass" : "FAIL"} (${ci.map((c) => `${c.name}=${c.conclusion ?? "pending"}`).join(", ") || "no checks"})`);

      if (ciPending) {
        console.log("  ⏭ Skipping — CI still pending after polling window; leaving for the next pass.");
        await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "skip", detail: "CI pending" });
        continue;
      }

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
        body: details.body,
        ciPassed,
        hasHumanComments,
      });
    }
  }
  } // end explicit-PR else

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
      prompt: `Review this pull request:\n\n# PR #${pr.number}: ${pr.title}\nBase: ${pr.baseRefName}\nHead: ${pr.headRefName}\n\n# PR description\n${pr.body ?? "(none)"}\n\n# Diff\n${prDiff.slice(0, 24000)}\n\n${REVIEW_PROMPT}${options.pr ? EXPLICIT_PR_NOTE : ""}`,
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
    const autoMerge = shouldAutoMerge({ accepted, ciPassed: pr.ciPassed, explicitPr: Boolean(options.pr) });
    let merged = false;

    // ---- 4. Merge (integration mode only; --pr NEVER auto-merges) ----------
    if (autoMerge) {
      console.log("  ✅ Review passed + CI green — merging.");
      try {
        await client.mergePullRequest(pr.repository, pr.number, pr.headRefName);
        await client.addPullRequestLabel(pr.repository, pr.number, "agent:reviewed");
        console.log("  ✅ Merged successfully.");
        merged = true;
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
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  ❌ Merge failed: ${message}`);
        // If the merge failed due to conflicts with the base branch, ask GitHub
        // to update the PR branch so CI can re-run; a later iteration retries.
        if (/405|merge conflicts/i.test(message)) {
          try {
            const updated = await client.updatePullRequestBranch(pr.repository, pr.number);
            if (updated) {
              console.log(`  🔄 Base branch changed — requested branch update; will retry after CI.`);
              await client.addPullRequestComment(pr.repository, pr.number,
                `## Merge deferred — branch update requested\n\nThe base branch moved ahead. The PR branch has been queued for update; once CI is green this PR will be reviewed and merged on a subsequent iteration.\n\n_— democracy-delicious-agent_`
              );
              await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "ok", detail: "merge conflict — branch update requested" });
              merged = false;
              decisions.push({ accepted, merged, commentUrl });
              continue;
            }
          } catch { /* fall through to normal failure path */ }
        }
        await client.addPullRequestComment(pr.repository, pr.number,
          `## Merge failed\n\n${message}\n\n_— democracy-delicious-agent_`
        );
        await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "fail", detail: `merge error: ${message}` });
      }
    } else if (options.pr && accepted) {
      // Explicit-PR mode: label and stop. For default-branch-targeting PRs
      // the human merge IS the deploy gate (e.g. pizza-eagle merge →
      // nightly update timer), so an accepted review never merges here.
      console.log("  ✅ Review passed — labeled agent:reviewed; merge stays human-gated in --pr mode.");
      await client.addPullRequestLabel(pr.repository, pr.number, "agent:reviewed");
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "ok", detail: "accepted — explicit PR, no auto-merge" });
    } else if (options.pr && !accepted) {
      console.log("  ❌ Review rejected — labeled agent:feedback; see comment for findings.");
      await client.addPullRequestLabel(pr.repository, pr.number, "agent:feedback");
      await logTimeline(config, { ts: new Date().toISOString(), event: "review", pr: pr.number, status: "skip", detail: "review rejected (explicit PR)" });
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