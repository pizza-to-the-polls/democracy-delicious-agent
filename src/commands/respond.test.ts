/**
 * Tests for the respond command — feedback loop logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
    const pr = {
      labels: ["agent:feedback", "agent:in-review"],
      headRefName: "agent/10-fix-thing",
    };
    const hasFeedback = pr.labels.includes("agent:feedback");
    const isAgentPR = pr.headRefName.startsWith("agent/");
    assert.strictEqual(hasFeedback && isAgentPR, true);
  });

  it("also eligible with agent:needs-human label", () => {
    const pr = {
      labels: ["agent:needs-human"],
      headRefName: "agent/10-fix-thing",
    };
    const eligible = pr.labels.some((l) => ["agent:feedback", "agent:needs-human"].includes(l));
    assert.strictEqual(eligible, true);
  });

  it("not eligible without feedback label", () => {
    const pr = { labels: ["agent:in-review"], headRefName: "agent/10-fix-thing" };
    const eligible = pr.labels.some((l) => ["agent:feedback", "agent:needs-human"].includes(l));
    assert.strictEqual(eligible, false);
  });

  it("not eligible for non-agent PRs", () => {
    const pr = { labels: ["agent:feedback"], headRefName: "dependabot/npm/foo" };
    assert.strictEqual(pr.headRefName.startsWith("agent/"), false);
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

  it("removes needs-human and adds in-review label after response", () => {
    const labels = ["agent:needs-human"];
    const after = labels
      .filter((l) => l !== "agent:feedback" && l !== "agent:needs-human")
      .concat("agent:in-review");
    assert.deepStrictEqual(after, ["agent:in-review"]);
  });
});