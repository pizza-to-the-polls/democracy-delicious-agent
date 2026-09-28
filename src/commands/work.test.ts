/**
 * Tests for the work-tree change detection used by the "Executor produced no
 * repository changes" guard in runWork (issue #11).
 *
 * These use real temp git repositories — no mocks — because the bug they
 * regress was precisely a wrong assumption about git state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../process.js";
import { hasRepositoryChanges } from "./work.js";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dd-work-test-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "Test"]);
  await writeFile(join(dir, "file.txt"), "initial\n");
  await runProcess("git", ["-C", dir, "add", "-A"]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "initial"]);
  return dir;
}

async function currentBranch(dir: string): Promise<string> {
  const result = await runProcess("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"]);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

test("hasRepositoryChanges is false for a clean tree at the branch point", async () => {
  const dir = await initRepo();
  try {
    // Degenerate base (HEAD): no unpushed commits, clean tree.
    assert.equal(await hasRepositoryChanges(dir, "HEAD"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasRepositoryChanges is true for uncommitted tracked modifications", async () => {
  const dir = await initRepo();
  try {
    await writeFile(join(dir, "file.txt"), "modified\n");
    assert.equal(await hasRepositoryChanges(dir, "HEAD"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasRepositoryChanges is true for untracked files", async () => {
  const dir = await initRepo();
  try {
    await writeFile(join(dir, "new-file.txt"), "untracked\n");
    assert.equal(await hasRepositoryChanges(dir, "HEAD"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasRepositoryChanges is true for committed-but-unpushed work (the #11 false negative)", async () => {
  const dir = await initRepo();
  try {
    const base = await currentBranch(dir);
    await runProcess("git", ["-C", dir, "checkout", "-q", "-b", "topic"]);
    await writeFile(join(dir, "file.txt"), "committed change\n");
    await runProcess("git", ["-C", dir, "add", "-A"]);
    await runProcess("git", ["-C", dir, "commit", "-q", "-m", "committed work"]);
    // Tree is clean — a status-only check would say "no changes" and fail
    // the cycle even though complete work exists on the branch.
    const status = await runProcess("git", ["-C", dir, "status", "--short"]);
    assert.equal(status.stdout.trim(), "");
    assert.equal(await hasRepositoryChanges(dir, base), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasRepositoryChanges falls back to status-only when the base ref is missing", async () => {
  const dir = await initRepo();
  try {
    // Unresolvable base ref (e.g. pruned remote): rev-list fails, so the
    // helper must not throw and must not report committed work as changes
    // it cannot see. Clean tree + missing ref → false.
    assert.equal(await hasRepositoryChanges(dir, "origin/does-not-exist"), false);
    // ...but uncommitted work is still detected without the ref.
    await writeFile(join(dir, "file.txt"), "modified\n");
    assert.equal(await hasRepositoryChanges(dir, "origin/does-not-exist"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});