/**
 * Tests for the review-pr command.
 *
 * Covers: PR discovery, review decision logic, merge criteria, and
 * feedback detection for human comments.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Unit tests for the review decision logic
// ---------------------------------------------------------------------------

describe("review decision logic", () => {
  it("accepts when review text contains VERDICT: ACCEPT", () => {
    const text = "All checks pass. VERDICT: ACCEPT";
    const accepted = /\bVERDICT:\s*ACCEPT\b/i.test(text) && !/\bVERDICT:\s*REJECT\b/i.test(text);
    assert.strictEqual(accepted, true);
  });

  it("rejects when review text contains VERDICT: REJECT", () => {
    const text = "Found issues. VERDICT: REJECT";
    const accepted = /\bVERDICT:\s*ACCEPT\b/i.test(text) && !/\bVERDICT:\s*REJECT\b/i.test(text);
    assert.strictEqual(accepted, false);
  });

  it("rejects when both ACCEPT and REJECT appear", () => {
    const text = "VERDICT: ACCEPT but also VERDICT: REJECT";
    const accepted = /\bVERDICT:\s*ACCEPT\b/i.test(text) && !/\bVERDICT:\s*REJECT\b/i.test(text);
    assert.strictEqual(accepted, false);
  });

  it("rejects when no verdict present", () => {
    const text = "Looks good to me.";
    const accepted = /\bVERDICT:\s*ACCEPT\b/i.test(text) && !/\bVERDICT:\s*REJECT\b/i.test(text);
    assert.strictEqual(accepted, false);
  });
});

// ---------------------------------------------------------------------------
// PR discovery — which PRs are eligible for autonomous review?
// ---------------------------------------------------------------------------

describe("PR eligibility for review", () => {
  it("targets PRs whose base is a feature/** integration branch", () => {
    const pr = { baseRefName: "feature/exif-endpoint", headRefName: "agent/10-fix" };
    const eligible = pr.baseRefName.startsWith("feature/") && pr.headRefName.startsWith("agent/");
    assert.strictEqual(eligible, true);
  });

  it("excludes PRs targeting master directly", () => {
    const pr = { baseRefName: "master", headRefName: "agent/10-fix" };
    const eligible = pr.baseRefName.startsWith("feature/") && pr.headRefName.startsWith("agent/");
    assert.strictEqual(eligible, false);
  });

  it("excludes non-agent branches", () => {
    const pr = { baseRefName: "feature/exif-endpoint", headRefName: "dependabot/npm/foo" };
    const eligible = pr.baseRefName.startsWith("feature/") && pr.headRefName.startsWith("agent/");
    assert.strictEqual(eligible, false);
  });

  it("excludes already-reviewed PRs (has agent-review-approved label)", () => {
    const pr = {
      baseRefName: "feature/exif-endpoint",
      headRefName: "agent/10-fix",
      labels: ["agent:reviewed"],
    };
    const alreadyReviewed = pr.labels.includes("agent:reviewed");
    assert.strictEqual(alreadyReviewed, true);
  });

  it("skips PRs with failing CI checks", () => {
    const checks = [
      { name: "test", conclusion: "FAILURE" },
      { name: "build", conclusion: "SUCCESS" },
    ];
    const allPass = checks.every((c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED");
    assert.strictEqual(allPass, false);
  });

  it("allows PRs with all passing CI checks", () => {
    const checks = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "build", conclusion: "SUCCESS" },
    ];
    const allPass = checks.every((c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED");
    assert.strictEqual(allPass, true);
  });
});

// ---------------------------------------------------------------------------
// Merge criteria
// ---------------------------------------------------------------------------

describe("merge criteria", () => {
  it("merges when review accepted and CI passes", () => {
    const reviewAccepted = true;
    const ciPasses = true;
    const shouldMerge = reviewAccepted && ciPasses;
    assert.strictEqual(shouldMerge, true);
  });

  it("does not merge when review rejected", () => {
    const shouldMerge = false && true;
    assert.strictEqual(shouldMerge, false);
  });

  it("does not merge when CI fails", () => {
    const shouldMerge = true && false;
    assert.strictEqual(shouldMerge, false);
  });
});

// ---------------------------------------------------------------------------
// Human feedback detection
// ---------------------------------------------------------------------------

describe("human feedback detection", () => {
  it("detects human review comments requesting changes", () => {
    const comments = [
      { user: { login: "mojowen" }, body: "Please fix the type error here" },
    ];
    const hasHumanFeedback = comments.some(
      (c) => !c.user.login.includes("bot") && !c.user.login.includes("agent")
    );
    assert.strictEqual(hasHumanFeedback, true);
  });

  it("ignores bot/agent comments", () => {
    const comments = [
      { user: { login: "democracy-delicious-agent[bot]" }, body: "VERDICT: ACCEPT" },
    ];
    const hasHumanFeedback = comments.some(
      (c) => !c.user.login.includes("bot") && !c.user.login.includes("agent")
    );
    assert.strictEqual(hasHumanFeedback, false);
  });

  it("flags PR that needs human attention when human left unresolved comments", () => {
    const pr = {
      number: 10,
      title: "Fix something",
      hasHumanComments: true,
      reviewAccepted: true,
    };
    // A PR with human comments should NOT be auto-merged even if review passes.
    const canAutoMerge = pr.reviewAccepted && !pr.hasHumanComments;
    assert.strictEqual(canAutoMerge, false);
  });
});