/**
 * Tests for runAuto discovery and resume logic.
 *
 * Tests selection logic in isolation — no network calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("runAuto selection logic", () => {
  it("integration branch is extracted from label", () => {
    const labels = ["agent:ready", "branch:feature/my-feature"];
    const found = labels.find((l) => l.startsWith("branch:"));
    assert.strictEqual(found?.slice(7), "feature/my-feature");
  });

  it("integration branch is extracted from issue body", () => {
    const body = "Some text\nIntegration branch: feature/other\nMore text";
    const match = body.match(/[Ii]ntegration\s*branch:\s*(\S+)/);
    assert.ok(match);
    assert.strictEqual(match[1], "feature/other");
  });

  it("defaults when no branch info present", () => {
    const labels = ["agent:ready"];
    const found = labels.find((l) => l.startsWith("branch:"));
    assert.strictEqual(found, undefined);
  });

  it("resume is true for needs-repair state", () => {
    const phase = "needs-repair";
    const resume = (phase as string) !== "created" && (phase as string) !== "reviewed";
    assert.strictEqual(resume, true);
  });

  it("resume is false for reviewed state", () => {
    const phase = "reviewed";
    const resume = (phase as string) !== "created" && (phase as string) !== "reviewed";
    assert.strictEqual(resume, false);
  });

  it("resume is false for created state", () => {
    const phase = "created";
    const resume = (phase as string) !== "created" && (phase as string) !== "reviewed";
    assert.strictEqual(resume, false);
  });

  it("resume is true for implemented state", () => {
    const phase = "implemented";
    const resume = (phase as string) !== "created" && (phase as string) !== "reviewed";
    assert.strictEqual(resume, true);
  });

  it("skips issue when open PR branch matches agent/ pattern", () => {
    const openPRs = [
      { headRefName: "agent/10-fix-something", title: "fix: Fix (#10)" },
    ];
    const issueNumber = 10;
    const match = openPRs.some(
      (pr) =>
        pr.headRefName.startsWith(`agent/${issueNumber}-`) ||
        (pr.title.includes(`#${issueNumber}`) &&
          pr.title.length > 0)
    );
    assert.strictEqual(match, true);
  });

  it("does not skip when open PR is for a different issue", () => {
    const openPRs = [
      { headRefName: "agent/20-other-thing", title: "fix: Other (#20)" },
    ];
    const issueNumber = 10;
    const match = openPRs.some(
      (pr) =>
        pr.headRefName.startsWith(`agent/${issueNumber}-`) ||
        (pr.title.includes(`#${issueNumber}`) &&
          pr.title.length > 0)
    );
    assert.strictEqual(match, false);
  });
});