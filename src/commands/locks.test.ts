/**
 * Tests for file-based locking in runAuto: acquisition, mutual exclusion,
 * and stale-lock takeover after a holder crash.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentConfig } from "../config.js";

import { defaultTryLock, defaultUnlock, processAlive } from "./run.js";

function tempConfig(workspace: string): AgentConfig {
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
      workspace,
    },
    models: {
      planner: { id: "test-model", thinking: "low" },
      executor: { id: "test-model", thinking: "low" },
      reviewer: { id: "test-model", thinking: "low" },
    },
    repositories: {
      "test-org/test-repo": { nodeVersion: "22", checks: { full: [] } },
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

async function tempWorkspace(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "dd-agent-locks-"));
}

describe("processAlive", () => {
  it("reports the current process as alive", () => {
    assert.equal(processAlive(process.pid), true);
  });

  it("reports an exited process as dead", () => {
    const exited = spawnSync("true");
    if (exited.pid === undefined) return; // platform without /bin/true
    assert.equal(processAlive(exited.pid), false);
  });
});

describe("defaultTryLock", () => {
  it("acquires a free lock and releases it on unlock", async () => {
    const workspace = await tempWorkspace();
    try {
      const tryLock = defaultTryLock(tempConfig(workspace));
      const unlock = defaultUnlock(tempConfig(workspace));

      assert.equal(await tryLock("test-org/test-repo", 42), true);
      await unlock("test-org/test-repo", 42);
      // Lock released — acquiring again must succeed.
      assert.equal(await tryLock("test-org/test-repo", 42), true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses a lock held by a live process", async () => {
    const workspace = await tempWorkspace();
    try {
      const config = tempConfig(workspace);
      await mkdir(resolve(workspace, "locks"), { recursive: true });
      const path = resolve(workspace, "locks", "test-org--test-repo-7.lock");
      await writeFile(path, `${process.pid}\n${new Date().toISOString()}`, { mode: 0o600 });

      const tryLock = defaultTryLock(config);
      assert.equal(await tryLock("test-org/test-repo", 7), false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("takes over a stale lock left by a crashed daemon", async () => {
    const workspace = await tempWorkspace();
    try {
      const exited = spawnSync("true");
      const config = tempConfig(workspace);
      await mkdir(resolve(workspace, "locks"), { recursive: true });
      const path = resolve(workspace, "locks", "test-org--test-repo-9.lock");
      const stalePid = exited.pid ?? 999_999_999;
      await writeFile(path, `${stalePid}\n2020-01-01T00:00:00Z`, { mode: 0o600 });

      const tryLock = defaultTryLock(config);
      assert.equal(await tryLock("test-org/test-repo", 9), true);

      // The reclaimed lock must now record our own PID.
      const content = await readFile(path, "utf8");
      assert.equal(Number.parseInt(content.split("\n")[0], 10), process.pid);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
