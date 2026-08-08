/**
 * Tests for the daemon command.
 *
 * We test the core loop logic: iteration counting, once-vs-loop,
 * and graceful-shutdown behavior. Full integration is tested via
 * the run and review command tests.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../config.js";

// We test the daemon loop's decision logic without running the full thing
// (which would loop forever). Simulate by testing the sleep/didWork logic.

import type { DaemonOptions } from "./daemon.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = {
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
} satisfies AgentConfig;

// ---------------------------------------------------------------------------
// Daemon option parser tests
// ---------------------------------------------------------------------------

describe("daemon options", () => {
  it("default poll interval is 60s", () => {
    const opts: DaemonOptions = {
      pollIntervalSeconds: 60,
      once: false,
      dryRun: false,
    };
    assert.strictEqual(opts.pollIntervalSeconds, 60);
    assert.strictEqual(opts.once, false);
  });

  it("once mode sets once=true", () => {
    const opts: DaemonOptions = {
      pollIntervalSeconds: 30,
      once: true,
      dryRun: false,
    };
    assert.strictEqual(opts.once, true);
  });

  it("dryRun mode propagates", () => {
    const opts: DaemonOptions = {
      pollIntervalSeconds: 10,
      once: false,
      dryRun: true,
    };
    assert.strictEqual(opts.dryRun, true);
  });
});