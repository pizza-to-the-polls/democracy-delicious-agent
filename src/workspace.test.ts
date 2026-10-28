/**
 * Tests for PR base-branch resolution in WorkspaceManager.prepare.
 *
 * Regression for the standalone-issue PR failure: prepare() auto-generates
 * `feature/<issue>-<slug>` when no integration branch is configured, and
 * the worktree correctly falls back to `origin/master` when that branch
 * doesn't exist on the remote — but the PR must also target a real remote
 * branch. Targeting the never-pushed auto-generated name 422s at PR
 * creation (`base: invalid`), which is how #308/#310 and #312 ended up as
 * manual PR recoveries.
 *
 * These use real temp git repositories — no mocks — matching the
 * work.test.ts philosophy: the bugs being guarded are wrong assumptions
 * about git state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSuccess, runProcess } from "./process.js";
import { WorkspaceManager, prBaseBranchForRef, AGENT_GIT_NAME, AGENT_GIT_EMAIL } from "./workspace.js";
import type { AgentConfig } from "./config.js";
import type { GitHubAppAuth } from "./github/auth.js";

const dummyAuth = {
  getInstallationToken: async () => ({ token: "dummy-token" }),
} as unknown as GitHubAppAuth;

const git = async (...args: string[]) =>
  assertSuccess(await runProcess("git", args));

async function initFixture(defaultBranch = "master"): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "dd-workspace-test-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");

  // Bare "origin" with a commit on its default branch.
  await git("init", "--bare", "-q", "-b", defaultBranch, bare);
  await git("clone", "-q", bare, seed);
  // Identity flags — CI runners have no global git config and
  // commit would otherwise fail with "Author identity unknown".
  await git(
    "-C",
    seed,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "initial",
  );
  await git("-C", seed, "push", "-q", "origin", defaultBranch);

  // Pre-seed the workspace's repository clone so prepare() skips its
  // github.com network fallback (rev-parse succeeds → fetch local origin).
  await git("clone", "-q", bare, join(root, "repositories", "repo"));

  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("prBaseBranchForRef strips the origin/ prefix", () => {
  assert.equal(prBaseBranchForRef("origin/master"), "master");
  assert.equal(
    prBaseBranchForRef("origin/feature/feed-observations"),
    "feature/feed-observations",
  );
});

test("prepare() targets master when the auto-generated integration branch is not on the remote", async () => {
  const fx = await initFixture();
  try {
    const manager = new WorkspaceManager(
      { paths: { workspace: fx.root } } as unknown as AgentConfig,
      dummyAuth,
    );
    const info = await manager.prepare("test/repo", 312, "Some Bug Title");
    assert.equal(info.baseBranch, "feature/312-some-bug-title");
    assert.equal(info.baseRef, "origin/master");
    assert.equal(info.prBaseBranch, "master");
    // Worktree commits must be attributed to the agent bot, not the machine's
    // global git config (regression: agent/recovery commits landed as the
    // human operator, e.g. 4ccf5d9 on PR #143).
    const gitName = await runProcess("git", ["-C", info.worktreePath, "config", "user.name"]);
    assert.equal(gitName.exitCode, 0);
    assert.equal(gitName.stdout.trim(), AGENT_GIT_NAME);
    const gitEmail = await runProcess("git", ["-C", info.worktreePath, "config", "user.email"]);
    assert.equal(gitEmail.exitCode, 0);
    assert.equal(gitEmail.stdout.trim(), AGENT_GIT_EMAIL);
  } finally {
    await fx.cleanup();
  }
});

test("prepare() falls back to the repo's actual default branch when base isn't master (pizza-eagle regression, 2026-10-28)", async () => {
  // pizza-eagle's default branch is main; the hardcoded origin/master
  // fallback made worktree creation fail with `invalid reference`.
  const fx = await initFixture("main");
  try {
    const manager = new WorkspaceManager(
      { paths: { workspace: fx.root } } as unknown as AgentConfig,
      dummyAuth,
    );
    // No --integration-branch: the auto-generated feature/314-… is not on
    // the remote, so the fallback must resolve origin/HEAD → origin/main.
    const info = await manager.prepare("test/repo", 314, "Some Bug Title");
    assert.equal(info.baseBranch, "feature/314-some-bug-title");
    assert.equal(info.baseRef, "origin/main");
    assert.equal(info.prBaseBranch, "main");
  } finally {
    await fx.cleanup();
  }
});

test("prepare() targets an explicit integration branch that exists on the remote", async () => {
  const fx = await initFixture();
  try {
    // Create feature/x in the bare origin and fetch it into the clone so
    // refs/remotes/origin/feature/x exists.
    await git("-C", join(fx.root, "origin.git"), "branch", "feature/x", "master");
    await git(
      "-C",
      join(fx.root, "repositories", "repo"),
      "fetch",
      "-q",
      "--prune",
      "origin",
    );

    const manager = new WorkspaceManager(
      { paths: { workspace: fx.root } } as unknown as AgentConfig,
      dummyAuth,
    );
    const info = await manager.prepare("test/repo", 313, "Some Bug Title", [], "feature/x");
    assert.equal(info.baseBranch, "feature/x");
    assert.equal(info.baseRef, "origin/feature/x");
    assert.equal(info.prBaseBranch, "feature/x");
  } finally {
    await fx.cleanup();
  }
});