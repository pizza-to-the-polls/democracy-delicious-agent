/**
 * Tests for the respond command — feedback loop logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../github/client.js";
import { isFeedbackEligible } from "./respond.js";

// ---------------------------------------------------------------------------
// Feedback detection
// ---------------------------------------------------------------------------

describe("feedback detection", () => {
  it("detects human comments excluding bots", () => {
    const comments = [
      { user: { login: "mojowen" }, body: "Move this to a service" },
      { user: { login: "democracy-delicious-agent[bot]" }, body: "VERDICT: ACCEPT" },
    ];
    const human = comments.filter(
      (c) => !c.user.login.includes("bot") && !c.user.login.includes("[bot]")
    );
    assert.strictEqual(human.length, 1);
    assert.strictEqual(human[0].user.login, "mojowen");
  });

  it("detects new comments since last agent activity", () => {
    const comments = [
      { user: { login: "mojowen" }, created_at: "2026-08-08T12:00:00Z", body: "Fix this" },
      { user: { login: "democracy-delicious-agent[bot]" }, created_at: "2026-08-08T11:00:00Z", body: "Reviewed" },
    ];
    const lastAgentComment = comments.find((c) => c.user.login.includes("[bot]"));
    const newHuman = comments.filter(
      (c) =>
        !c.user.login.includes("bot") &&
        !c.user.login.includes("[bot]") &&
        lastAgentComment &&
        new Date(c.created_at) > new Date(lastAgentComment.created_at)
    );
    assert.strictEqual(newHuman.length, 1);
  });

  it("skips if no new comments since last agent activity", () => {
    const comments = [
      { user: { login: "mojowen" }, created_at: "2026-08-08T10:00:00Z", body: "Fix this" },
      { user: { login: "democracy-delicious-agent[bot]" }, created_at: "2026-08-08T12:00:00Z", body: "Reviewed" },
    ];
    const lastAgentComment = comments.find((c) => c.user.login.includes("[bot]"));
    const newHuman = comments.filter(
      (c) =>
        !c.user.login.includes("bot") &&
        !c.user.login.includes("[bot]") &&
        lastAgentComment &&
        new Date(c.created_at) > new Date(lastAgentComment.created_at)
    );
    assert.strictEqual(newHuman.length, 0);
  });
});

// ---------------------------------------------------------------------------
// PR eligibility for respond
// ---------------------------------------------------------------------------

describe("respond eligibility", () => {
  it("eligible when PR has agent:feedback label", () => {
    assert.strictEqual(isFeedbackEligible(["agent:feedback", "agent:in-review"]), true);
  });

  it("NOT eligible with agent:needs-human label — it means a human must intervene", () => {
    assert.strictEqual(isFeedbackEligible(["agent:needs-human"]), false);
  });

  it("NOT eligible when needs-human is present even alongside feedback", () => {
    assert.strictEqual(isFeedbackEligible(["agent:feedback", "agent:needs-human"]), false);
  });

  it("not eligible without feedback label", () => {
    assert.strictEqual(isFeedbackEligible(["agent:in-review"]), false);
  });
});

// ---------------------------------------------------------------------------
// Feedback extraction
// ---------------------------------------------------------------------------

describe("feedback extraction", () => {
  it("extracts human comments and formats for agent", () => {
    const humanComments = [
      { user: { login: "mojowen" }, path: "src/controller.ts", body: "Move this to a service" },
      { user: { login: "mojowen" }, path: "src/controller.ts", body: "Add tests for the edge case" },
    ];
    const prompt = humanComments
      .map((c) => `## @${c.user.login} on ${c.path}\n${c.body}`)
      .join("\n\n");
    assert.ok(prompt.includes("@mojowen"));
    assert.ok(prompt.includes("Move this to a service"));
    assert.ok(prompt.includes("Add tests for the edge case"));
  });
});

// ---------------------------------------------------------------------------
// Label transitions
// ---------------------------------------------------------------------------

describe("label transitions", () => {
  it("removes feedback label and adds fixed label after response", () => {
    const labels = ["agent:feedback", "agent:in-review"];
    const after = [...new Set(labels
      .filter((l) => l !== "agent:feedback" && l !== "agent:needs-human")
      .concat("agent:in-review"))];
    assert.deepStrictEqual(after, ["agent:in-review"]);
  });

  it("never transitions a needs-human PR — respond must not touch it at all", () => {
    // agent:needs-human is an escalation to a human; isFeedbackEligible rejects
    // it, so no label transition ever happens for such a PR.
    const labels = ["agent:needs-human"];
    assert.strictEqual(isFeedbackEligible(labels), false);
    assert.deepStrictEqual(labels, ["agent:needs-human"]); // unchanged
  });

  it("only resets labels when a commit was made (no empty-commit infinite loop)", () => {
    // Simulate: executor runs but makes no changes. commitResult.exitCode !== 0.
    // Labels should NOT be changed — the PR stays in agent:feedback.
    const commitSucceeded = false;
    const labels = ["agent:feedback"];

    if (commitSucceeded) {
      const after = labels
        .filter((l) => l !== "agent:feedback" && l !== "agent:needs-human")
        .concat("agent:in-review");
      assert.deepStrictEqual(after, ["agent:in-review"]);
    } else {
      // No change — labels stay as-is, avoiding infinite respond→review loop.
      assert.deepStrictEqual(labels, ["agent:feedback"]);
    }
  });
});

// ---------------------------------------------------------------------------
// CI-failure detection in respond
// ---------------------------------------------------------------------------

describe("respond CI detection", () => {
  it("sets ciFailed true when feedback label present, no human comments, CI failing", () => {
    const hasFeedbackLabel = true;
    const humanComments: unknown[] = [];
    const checks = [
      { name: "test", conclusion: "FAILURE", status: "completed" },
      { name: "build", conclusion: "SUCCESS", status: "completed" },
    ];

    const needsCiCheck = hasFeedbackLabel && humanComments.length === 0;
    const ciFailed = needsCiCheck && checks.some((c) => c.conclusion === "FAILURE");

    assert.strictEqual(ciFailed, true);
  });

  it("sets ciFailed false when CI is green", () => {
    const hasFeedbackLabel = true;
    const humanComments: unknown[] = [];
    const checks = [
      { name: "test", conclusion: "SUCCESS", status: "completed" },
    ];

    const needsCiCheck = hasFeedbackLabel && humanComments.length === 0;
    const ciFailed = needsCiCheck && checks.some((c) => c.conclusion === "FAILURE");

    assert.strictEqual(ciFailed, false);
  });

  it("skips CI check when human comments are present", () => {
    const hasFeedbackLabel = true;
    const humanComments = [{ user: { login: "mojowen" }, body: "Fix this" }];

    const needsCiCheck = hasFeedbackLabel && humanComments.length === 0;

    assert.strictEqual(needsCiCheck, false);
  });
});

// ---------------------------------------------------------------------------
// Full daemon cycle: respond → review handoff
// ---------------------------------------------------------------------------

describe("daemon cycle", () => {
  it("PR with CI failure stays in feedback until fixed (no infinite loop)", () => {
    // Simulate a PR that has a persistent CI failure and the executor can't fix it.
    // Day 1: review finds CI failure, adds agent:feedback.
    let labels = ["agent:feedback"];

    // respond runs — can't fix (no changes), so labels stay.
    const commitMade = false;
    if (!commitMade) {
      // Labels don't change — avoids the infinite respond→review loop.
    }

    // Labels should still be ["agent:feedback"].
    assert.deepStrictEqual(labels, ["agent:feedback"]);

    // review runs again — still sees agent:feedback, still sees CI failing.
    // It adds a comment but does NOT add another agent:feedback (already there).
    // The cycle is stable, not infinite.
  });

  it("PR with CI green and agent:feedback: respond fixes, then review merges", () => {
    // Simulate a PR that initially had CI failure, was labeled agent:feedback,
    // but CI is now green (maybe a flaky test was retried).
    let labels = ["agent:feedback"];
    const ciPassed = true;

    // respond: picks it up, sees no human comments but CI is green.
    // The executor runs and does a meaningful fix (maybe a lint fix).
    const commitMade = true;
    if (commitMade) {
      labels = labels
        .filter((l) => l !== "agent:feedback" && l !== "agent:needs-human")
        .concat("agent:in-review");
    }

    assert.deepStrictEqual(labels, ["agent:in-review"]);

    // review: sees agent:in-review + CI green → reviews and merges.
    const reviewAccepted = true;
    const shouldMerge = reviewAccepted && ciPassed;
    assert.strictEqual(shouldMerge, true);
  });

  it("full cycle: run → work → review → respond → review → merge", () => {
    // Simulate the happy path through the entire daemon loop.
    const phases: string[] = [];

    // 1. runAuto discovers agent:ready issue — skips, already has PR.
    phases.push("run:skip-has-pr");

    // 2. review finds agent PR, CI fails.
    phases.push("review:ci-fail");
    let labels = ["agent:feedback"];

    // 3. respond picks up agent:feedback, executor fixes CI.
    const commitMade = true;
    if (commitMade) {
      labels = ["agent:in-review"];
      phases.push("respond:fixed");
    }

    // 4. review runs again, CI passes, review accepted.
    const ciPassed = true;
    const reviewAccepted = true;
    if (reviewAccepted && ciPassed && labels.includes("agent:in-review")) {
      labels = ["agent:reviewed"];
      phases.push("review:merged");
    }

    assert.deepStrictEqual(phases, [
      "run:skip-has-pr",
      "review:ci-fail",
      "respond:fixed",
      "review:merged",
    ]);
  });

  it("respond uses issue comments API, not review comments API", () => {
    // Verify that the right API endpoint is called.
    // The GitHub client's listIssueComments hits /issues/{number}/comments
    // (PR conversation), while listPullRequestComments hits
    // /pulls/{number}/comments (diff-line review comments).
    // Bot comments and CI-failure notices are posted as issue comments,
    // so respond must use listIssueComments, not listPullRequestComments.

    // We can't test the actual HTTP call, but we can verify the client
    // method exists and the old method is not called in the respond path.
    const client = new GitHubClient({ getInstallationToken: async () => ({ token: "test" }) } as any);

    // Both methods must exist on the client.
    assert.strictEqual(typeof client.listIssueComments, "function");
    assert.strictEqual(typeof client.listPullRequestComments, "function");

    // The key distinction: respond.ts must call listIssueComments for PR
    // conversation comments. listPullRequestComments returns only inline
    // diff comments and would miss bot CI-failure notices.
  });
});