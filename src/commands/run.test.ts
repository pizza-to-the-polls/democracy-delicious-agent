/**
 * Tests for the runAuto auto-discovery command.
 *
 * Dependency injection is used via RunAutoDeps so tests work with
 * Node's native test runner (node --test) without module mocking.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../config.js";
import type { RunAutoDeps } from "./run.js";

import { runAuto } from "./run.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config: AgentConfig = {
  github: {
    organization: "test-org",
    appId: 1,
    installationId: 1,
    projectNumber: 1,
    repositories: ["test-org/test-repo", "test-org/other-repo"],
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
    "test-org/other-repo": { nodeVersion: "22", checks: { full: [] } },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockIssue = { number: number; title: string; body: string | null; labels: string[] };
type MockPR = { number: number; title: string; headRefName: string; baseRefName: string };

/** Build a sequential mock function that returns successive values, falling back to the last value. */
function sequentialFn<T>(values: T[], fallback: T): ReturnType<typeof mock.fn<() => Promise<T>>> {
  let i = 0;
  return mock.fn(async () => {
    if (i < values.length) return values[i++]!;
    return fallback;
  });
}

function buildDeps(overrides: {
  searchIssues?: MockIssue[][];
  listOpenPRs?: MockPR[][];
  stateLoad?: unknown[];
  workFn?: ReturnType<typeof mock.fn<() => Promise<number>>>;
  tryLock?: (repo: string, issue: number) => Promise<boolean>;
  unlock?: (repo: string, issue: number) => Promise<void>;
}): RunAutoDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkClient = (): any => ({
    searchIssues: sequentialFn(overrides.searchIssues ?? [], [] as MockIssue[]),
    listOpenPullRequests: sequentialFn(overrides.listOpenPRs ?? [], [] as MockPR[]),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkStore = (): any => ({
    load: sequentialFn(overrides.stateLoad ?? [null], null),
  });

  return {
    client: mkClient(),
    store: mkStore(),
    work: overrides.workFn ?? mock.fn(async () => 0),
    tryLock: overrides.tryLock ?? (async () => true),
    unlock: overrides.unlock ?? (async () => {}),
  };
}

/** First call args of a mock fn. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstCallArgs(fn: any): unknown[] {
  return (fn.mock.calls[0] as { arguments: unknown[] } | undefined)?.arguments ?? [];
}

/** Options object passed as second argument to runWork. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function workOptions(fn: any) {
  return firstCallArgs(fn)[1] as { repository: string; issueNumber: number; resume: boolean; integrationBranch?: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAuto", () => {
  it("picks the first agent:ready issue with no open PR", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[{ number: 10, title: "Fix something", body: null, labels: ["agent:ready"] }]],
      workFn,
    });

    await runAuto(config, { dryRun: true }, deps);

    assert.strictEqual(workFn.mock.calls.length, 0); // dryRun
  });

  it("skips issues that already have an open agent PR", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[{ number: 10, title: "Fix something", body: null, labels: ["agent:ready"] }]],
      listOpenPRs: [[
        { number: 1, title: "fix: Fix something (#10)", headRefName: "agent/10-fix-something", baseRefName: "master" },
      ]],
      workFn,
    });

    const exitCode = await runAuto(config, { dryRun: true }, deps);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(workFn.mock.calls.length, 0);
  });

  it("reads integration branch from label", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[
        { number: 10, title: "Add feature", body: null, labels: ["agent:ready", "branch:feature/test-branch"] },
      ]],
      workFn,
    });

    await runAuto(config, { dryRun: false }, deps);

    const opts = workOptions(workFn);
    assert.strictEqual(opts.repository, "test-org/test-repo");
    assert.strictEqual(opts.issueNumber, 10);
    assert.strictEqual(opts.integrationBranch, "feature/test-branch");
  });

  it("reads integration branch from issue body when no label", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[
        { number: 10, title: "Add feature", body: "Some text\nIntegration branch: feature/my-branch\nMore text", labels: ["agent:ready"] },
      ]],
      workFn,
    });

    await runAuto(config, { dryRun: false }, deps);

    assert.strictEqual(workOptions(workFn).integrationBranch, "feature/my-branch");
  });

  it("defaults integration branch to undefined when on master", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[
        { number: 10, title: "Add feature", body: "Just a body", labels: ["agent:ready"] },
      ]],
      workFn,
    });

    await runAuto(config, { dryRun: false }, deps);

    assert.strictEqual(workOptions(workFn).integrationBranch, undefined);
  });

  it("scans all approved repos", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [
        [],
        [{ number: 20, title: "Other repo issue", body: null, labels: ["agent:ready"] }],
      ],
      workFn,
    });

    await runAuto(config, { dryRun: true }, deps);

    // searchIssues should have been called twice (once per repo).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const si = (deps.client as any).searchIssues as ReturnType<typeof mock.fn>;
    assert.strictEqual(si.mock.calls.length, 2);
  });

  it("returns 0 when no agent:ready issues exist", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({ workFn });

    const exitCode = await runAuto(config, { dryRun: true }, deps);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(workFn.mock.calls.length, 0);
  });

  it("auto-resumes when existing state is found", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[
        { number: 10, title: "Fix something", body: null, labels: ["agent:ready", "branch:feature/x"] },
      ]],
      stateLoad: [{ repository: "test-org/test-repo", issueNumber: 10, phase: "needs-repair", costs: {} }],
      workFn,
    });

    await runAuto(config, { dryRun: false }, deps);

    assert.strictEqual(workOptions(workFn).resume, true);
  });

  it("skips issues with 'reviewed' state entirely", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[
        { number: 10, title: "Fix something", body: null, labels: ["agent:ready", "branch:feature/x"] },
        { number: 11, title: "Unreviewed issue", body: null, labels: ["agent:ready"] },
      ]],
      stateLoad: [
        { repository: "test-org/test-repo", issueNumber: 10, phase: "reviewed", costs: {} },
        null,
      ],
      workFn,
    });

    await runAuto(config, { dryRun: false }, deps);

    // #10 was skipped, so #11 should be worked.
    assert.strictEqual(workFn.mock.calls.length, 1);
    assert.strictEqual(workOptions(workFn).issueNumber, 11);
  });

  it("skips locked issue and tries next candidate", async () => {
    const workFn = mock.fn(async () => 0);
    let lockCalls = 0;
    const deps = buildDeps({
      searchIssues: [
        [
          { number: 10, title: "Locked issue", body: null, labels: ["agent:ready"] },
          { number: 11, title: "Unlocked issue", body: null, labels: ["agent:ready"] },
        ],
      ],
      workFn,
      tryLock: async (_repo, issue) => {
        lockCalls++;
        return issue !== 10; // #10 is locked, #11 is available
      },
    });

    await runAuto(config, { dryRun: false }, deps);

    // Should have tried to lock #10 (failed), then #11 (succeeded).
    assert.strictEqual(lockCalls, 2);
    // Should have worked #11.
    assert.strictEqual(workFn.mock.calls.length, 1);
    assert.strictEqual(workOptions(workFn).issueNumber, 11);
  });

  it("returns 0 when all candidates are locked", async () => {
    const workFn = mock.fn(async () => 0);
    const deps = buildDeps({
      searchIssues: [[
        { number: 10, title: "Locked issue", body: null, labels: ["agent:ready"] },
      ]],
      workFn,
      tryLock: async () => false, // Everything is locked.
    });

    const exitCode = await runAuto(config, { dryRun: false }, deps);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(workFn.mock.calls.length, 0);
  });
});