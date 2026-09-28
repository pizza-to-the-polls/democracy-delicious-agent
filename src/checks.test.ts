import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";
import { runChecks, selectCommands, type RepositoryChecks } from "./checks.js";
import { runProcess } from "./process.js";

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

// ── runChecks git behavior (issue #11) ───────────────────────────────────
// The fix step must never commit or amend: at checks time the executor's
// changes are uncommitted working-tree modifications, so a commit —
// especially `--amend` — would fold them into the base commit and rewrite
// upstream history, then trip the false "Executor produced no repository
// changes" failure.
//
// runChecks shells out through nvm (see the wrapper in checks.ts), so these
// integration tests only run where nvm is installed (the operator machine).

const nvmAvailable = existsSync(join(homedir(), ".nvm", "nvm.sh"));

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dd-checks-test-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "Test"]);
  await writeFile(join(dir, "workfile.txt"), "initial\n");
  await runProcess("git", ["-C", dir, "add", "-A"]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "initial"]);
  return dir;
}

async function headSha(dir: string): Promise<string> {
  const result = await runProcess("git", ["-C", dir, "rev-parse", "HEAD"]);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

function testConfig(fix: string): AgentConfig {
  return {
    github: {
      organization: "test-org",
      appId: 1,
      installationId: 1,
      projectNumber: 1,
      repositories: ["test-org/test-repo"],
    },
    paths: {
      githubPrivateKey: "~/.config/test.pem",
      environmentFile: "~/.config/test.env",
      workspace: "~/test-workspace",
    },
    models: {
      planner: { id: "test-model", thinking: "low" },
      executor: { id: "test-model", thinking: "low" },
      reviewer: { id: "test-model", thinking: "low" },
    },
    repositories: {
      "test-org/test-repo": { nodeVersion: "22", checks: { fix, full: ["true"] } },
    },
    budget: { dailyUsd: 100, autonomousStopUsd: 200, absoluteUsd: 500 },
    limits: {
      globalConcurrency: 1,
      issueWallClockMinutes: 45,
      maxModelTurns: 30,
      maxTestRuns: 4,
      maxRepairCycles: 3,
    },
  };
}

test("runChecks does not commit after a successful fix step (HEAD unchanged, work stays in the tree)", { skip: !nvmAvailable }, async () => {
  const dir = await initRepo();
  try {
    const before = await headSha(dir);
    const results = await runChecks({
      config: testConfig("echo fixed >> workfile.txt"),
      repository: "test-org/test-repo",
      issueNumber: 1,
      cwd: dir,
    });

    // Fix step succeeded and modified a tracked file.
    assert.equal(results.length, 2, "fix + full check should both have run");
    assert.equal(results[0].exitCode, 0, results[0].stderr);

    // Regression (issue #11): nothing was committed or amended.
    assert.equal(await headSha(dir), before);

    // The fix output survives as uncommitted working-tree changes that
    // the reviewer's status/diff will see.
    const status = await runProcess("git", ["-C", dir, "status", "--short"]);
    assert.match(status.stdout, /workfile\.txt/);
    const diff = await runProcess("git", ["-C", dir, "diff"]);
    assert.ok(diff.stdout.includes("+fixed"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChecks surfaces a failed fix step without committing anything", { skip: !nvmAvailable }, async () => {
  const dir = await initRepo();
  try {
    const before = await headSha(dir);
    const results = await runChecks({
      config: testConfig("echo 'lint error' >&2; exit 1"),
      repository: "test-org/test-repo",
      issueNumber: 1,
      cwd: dir,
    });

    // Fix failure does not bail — the full check still runs (reviewer sees raw output).
    assert.equal(results.length, 2);
    assert.equal(results[0].exitCode, 1);
    assert.ok(results[0].stderr.includes("lint error"));
    assert.equal(await headSha(dir), before);

    const status = await runProcess("git", ["-C", dir, "status", "--short"]);
    assert.equal(status.stdout.trim(), "", "no fix output means a clean tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
