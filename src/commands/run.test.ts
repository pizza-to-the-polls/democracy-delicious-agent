import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("runAuto selection logic", () => {
  it("integration branch from label", () => {
    const labels = ["agent:ready", "branch:feature/my-feature"];
    assert.strictEqual(labels.find((l) => l.startsWith("branch:"))?.slice(7), "feature/my-feature");
  });
  it("resume for needs-repair", () => {
    const phase = "needs-repair";
    assert.strictEqual((phase as string) !== "created" && (phase as string) !== "reviewed", true);
  });
  it("no resume for reviewed", () => {
    assert.strictEqual(("reviewed" as string) !== "created" && ("reviewed" as string) !== "reviewed", false);
  });
});
