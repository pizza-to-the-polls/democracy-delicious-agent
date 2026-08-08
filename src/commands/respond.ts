/**
 * Respond to human feedback on agent PRs.
 *
 * Finds open agent PRs with human review comments, feeds them to an executor
 * agent who implements the requested changes, pushes to the same branch, and
 * resets labels so the `review` command picks it up again.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentConfig } from "../config.js";
import { expandHome } from "../config.js";
import { GitHubAppAuth } from "../github/auth.js";
import { GitHubClient } from "../github/client.js";
import { WorkspaceManager } from "../workspace.js";
import { StateStore } from "../state.js";
import { runAgentSession } from "../agent/run-session.js";
import { getOpenRouterUsage, assertBudgetAvailable } from "../budget.js";
import { runProcess, assertSuccess } from "../process.js";
import { logTimeline } from "../timeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedbackPR {
  repository: string;
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  humanComments: Array<{
    user: { login: string };
    path?: string;
    body: string;
  }>;
  ciFailed: boolean;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runRespond(config: AgentConfig, options: {
  dryRun: boolean;
  repo?: string;
}): Promise<number> {
  const usage = await getOpenRouterUsage();
  assertBudgetAvailable(usage, config.budget, 0.5);

  const keyPath = expandHome(config.paths.githubPrivateKey);
  const auth = new GitHubAppAuth(config.github.appId, config.github.installationId, keyPath);
  const client = new GitHubClient(auth);

  const repos = options.repo
    ? [options.repo]
    : config.github.repositories.filter((r) => r !== "pizza-to-the-polls/democracy-delicious-agent");

  // ---- 1. Find PRs with human feedback ----------------------------------
  const toProcess: FeedbackPR[] = [];

  for (const repo of repos) {
    const prs = await client.listOpenPullRequests(repo);
    for (const pr of prs) {
      if (!pr.headRefName.startsWith("agent/")) continue;

      const details = await client.getPullRequest(repo, pr.number);
      const labels = details.labels.map((l: { name: string }) => l.name);
      const hasFeedbackLabel = labels.some((l) => ["agent:feedback", "agent:needs-human"].includes(l));

      // Use issue comments (PR conversation), not review comments (diff-line).
      const comments = await client.listIssueComments(repo, pr.number);
      const humanComments = comments.filter(
        (c) => !c.user.login.includes("bot") && !c.user.login.includes("[bot]")
      );

      // Also check CI status for bot-triggered feedback.
      let ciFailed = false;
      if (hasFeedbackLabel && humanComments.length === 0) {
        try {
          const checks = await client.getPullRequestChecks(repo, pr.number);
          ciFailed = checks.some((c) => c.conclusion === "FAILURE");
          console.log(`  PR #${pr.number}: CI ${ciFailed ? "FAILING" : "passing"} (${checks.map((c) => `${c.name}=${c.conclusion}`).join(", ")})`);
        } catch (err) {
          console.log(`  PR #${pr.number}: could not fetch CI checks: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (hasFeedbackLabel || humanComments.length > 0) {
        const allComments = humanComments.length > 0 ? humanComments.slice(-5) : comments.slice(-5);
        toProcess.push({
          repository: repo,
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          humanComments: allComments,
          ciFailed,
        });
      }
    }
  }

  if (toProcess.length === 0) {
    console.log("No agent PRs with pending human feedback.");
    return 0;
  }

  console.log(`Found ${toProcess.length} PR(s) with feedback: ${toProcess.map((p) => `#${p.number}`).join(", ")}`);

  for (const pr of toProcess) {
    console.log(`\n--- PR #${pr.number}: ${pr.title} ---`);
    console.log(`  CI failed: ${pr.ciFailed}`);
    console.log(`  ${pr.humanComments.length} human/bot comment(s)`);

    if (options.dryRun) {
      console.log("  Dry run — would implement fixes.");
      continue;
    }

    // ---- 2. Prepare worktree --------------------------------------------
    const workspace = await new WorkspaceManager(config, auth).prepare(
      pr.repository,
      pr.number,
      `respond-to-feedback-${pr.number}`,
      [],
      pr.baseRefName,
    );

    // Check out the PR branch in the worktree.
    await runProcess("git", ["-C", workspace.worktreePath, "fetch", "origin", pr.headRefName]);
    await runProcess("git", ["-C", workspace.worktreePath, "checkout", pr.headRefName]);
    await runProcess("git", ["-C", workspace.worktreePath, "pull", "origin", pr.headRefName]);

    // ---- 3. Build feedback prompt ---------------------------------------
    const feedbackText = pr.humanComments
      .map((c) => `### @${c.user.login}${c.path ? ` on \`${c.path}\`` : ""}\n> ${c.body}`)
      .join("\n\n");

    const ciHint = pr.ciFailed
      ? "\n\n**CI is failing on this PR.** Check the test output, find the root cause (e.g. type errors, test failures, imports), and fix it."
      : "";

    const prompt = `## Respond to feedback on PR #${pr.number}

The following feedback was left on your PR. Implement the requested changes.

${feedbackText || "(No written feedback — check the PR comments and CI status on GitHub.)"}${ciHint}

# Instructions
- Read each comment carefully. Address every request.
- If CI is failing, find and fix the root cause.
- Make minimal, focused changes. Don't refactor unrelated code.
- Run the project's fix/lint command when done.
- The orchestrator will push your changes and re-request review.`;

    // ---- 4. Run executor agent ------------------------------------------
    console.log("  Implementing feedback…");
    const executor = await runAgentSession({
      config,
      role: "executor",
      cwd: workspace.worktreePath,
      prompt,
      tools: ["read", "grep", "find", "ls", "edit", "write"],
      systemAppend: "Implement the requested changes. Be precise and minimal. The orchestrator handles git.",
      sessionName: `respond-${pr.repository.replace("/", "-")}-${pr.number}`,
    });

    console.log(`  Executor cost: $${executor.cost.toFixed(4)}`);

    // ---- 5. Commit and push ---------------------------------------------
    const env = await auth.getInstallationToken().then(({ token }) => ({
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    }));

    await runProcess("git", ["-C", workspace.worktreePath, "add", "-A"], { env });
    const commitResult = await runProcess("git", ["-C", workspace.worktreePath, "commit", "-m", `fix: respond to review feedback on PR #${pr.number}`], { env });
    if (commitResult.exitCode === 0) {
      await runProcess("git", ["-C", workspace.worktreePath, "push", "origin", pr.headRefName], { env });

      // ---- 6. Update labels -----------------------------------------------
      // Remove feedback labels, add in-review so the review loop picks it up.
      for (const label of ["agent:feedback", "agent:needs-human"]) {
        try { await client.removeIssueLabel(pr.repository, pr.number, label); } catch { /* ignore */ }
      }
      await client.addIssueLabel(pr.repository, pr.number, "agent:in-review");

      // Post a comment noting the fix.
      await client.addPullRequestComment(pr.repository, pr.number,
        `✅ Implemented fixes for the review feedback.\n\n_— democracy-delicious-agent_`
      );

      await logTimeline(config, { ts: new Date().toISOString(), event: "respond", pr: pr.number, status: "ok", detail: "fix committed and pushed" });
      console.log("  ✅ Fixes pushed, PR re-opened for review.");
    } else {
      await logTimeline(config, { ts: new Date().toISOString(), event: "respond", pr: pr.number, status: "skip", detail: "no changes to commit" });
      console.log("  ⚠ No changes to commit — skipping label update. Check manually.");
    }
  }

  return 0;
}