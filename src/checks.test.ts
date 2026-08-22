import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCommands, type RepositoryChecks } from "./checks.js";

const checks: RepositoryChecks = {
  fix: "npm run fix",
  targeted: "npm test -- --runTestsByPath src/specific.test.ts",
  full: ["npm run prettier", "npm run lint"],
};

test("selectCommands includes fix before full checks by default", () => {
  assert.deepEqual(selectCommands(checks), [
    { command: "npm run fix", kind: "fix" },
    { command: "npm run prettier", kind: "check" },
    { command: "npm run lint", kind: "check" },
  ]);
});

test("selectCommands skips the mutating fix command when skipFix is set", () => {
  // --review-only must never mutate the worktree under review.
  const selected = selectCommands(checks, { skipFix: true }).map((entry) => entry.kind);
  assert.deepEqual(selected, ["check", "check"]);
});

test("selectCommands omits fix when not configured", () => {
  const noFix: RepositoryChecks = { targeted: checks.targeted, full: checks.full };
  assert.deepEqual(selectCommands(noFix).map((entry) => entry.command), checks.full);
});

test("selectCommands uses targeted check only in targeted mode", () => {
  assert.deepEqual(
    selectCommands(checks, { targetedOnly: true }).map((entry) => entry.command),
    ["npm run fix", "npm test -- --runTestsByPath src/specific.test.ts"],
  );
  const withoutFix = selectCommands(checks, { targetedOnly: true, skipFix: true }).map((entry) => entry.command);
  assert.deepEqual(withoutFix, [checks.targeted]);
});

test("selectCommands falls back to full checks when targeted is unset", () => {
  const noTargeted: RepositoryChecks = { fix: checks.fix, full: checks.full };
  const commands = selectCommands(noTargeted, { targetedOnly: true }).map((entry) => entry.command);
  assert.deepEqual(commands, ["npm run fix", ...checks.full]);
});
