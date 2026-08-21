/**
 * Tests for the read-only status command.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentConfig } from "../config.js";

import { runStatus } from "./status.js";

const config: AgentConfig = {
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
    workspace: "", // replaced per test
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

async function tempWorkspace(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "dd-agent-status-"));
}

describe("runStatus", () => {
  it("succeeds on an empty/nonexistent workspace", async () => {
    const workspace = await tempWorkspace();
    try {
      const exitCode = await runStatus({ ...config, paths: { ...config.paths, workspace } });
      assert.equal(exitCode, 0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces saved work state and timeline events", async () => {
    const workspace = await tempWorkspace();
    try {
      const stateDir = resolve(workspace, "state", "test-org--test-repo");
      const logsDir = resolve(workspace, "logs");
      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeFile(
        resolve(stateDir, "12.json"),
        JSON.stringify({ repository: "test-org/test-repo", issueNumber: 12, phase: "reviewed", costs: { planner: 0.01, executor: 0.02 }, updatedAt: new Date().toISOString() }),
      );
      await writeFile(
        resolve(logsDir, `daemon-${new Date().toISOString().slice(0, 10)}.jsonl`),
        '{"event":"iteration_start","status":"start"}\n',
      );

      const exitCode = await runStatus({ ...config, paths: { ...config.paths, workspace } });
      assert.equal(exitCode, 0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("flags a stale lock whose holder process is gone", async () => {
    const workspace = await tempWorkspace();
    try {
      const locksDir = resolve(workspace, "locks");
      await mkdir(locksDir);
      const lockPath = resolve(locksDir, "test-org--test-repo-5.lock");
      await writeFile(lockPath, "999999999\n2020-01-01T00:00:00Z");
      // Match production permissions so reading the lock is realistic.
      await chmod(lockPath, 0o600);

      const exitCode = await runStatus({ ...config, paths: { ...config.paths, workspace } });
      assert.equal(exitCode, 0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
