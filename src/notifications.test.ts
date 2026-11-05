import test from "node:test";
import assert from "node:assert/strict";
import { postNotification, notifyBudgetWarning } from "./notifications.js";
import type { AgentConfig } from "./config.js";

const base = {
  github: { organization: "pizza-to-the-polls", appId: 1, installationId: 1, projectNumber: 1, repositories: ["a/b"] },
  paths: { githubPrivateKey: "~/k.pem", environmentFile: "~/env", workspace: "~/w" },
  models: {
    planner: { id: "m", thinking: "medium" },
    executor: { id: "m", thinking: "medium" },
    reviewer: { id: "m", thinking: "high" },
  },
  repositories: {},
  budget: { dailyUsd: 15, autonomousStopUsd: 350, absoluteUsd: 400 },
  limits: { globalConcurrency: 1, issueWallClockMinutes: 30, maxModelTurns: 10, maxTestRuns: 3, maxRepairCycles: 2 },
} as unknown as AgentConfig;

test("postNotification: silent no-op without notifications config", async () => {
  delete process.env.DD_AGENT_TEST_WEBHOOK;
  assert.equal(await postNotification(base, "hello"), false);
});

test("postNotification: silent no-op when the env var is unset", async () => {
  delete process.env.DD_AGENT_TEST_WEBHOOK;
  const config = { ...base, notifications: { webhookEnv: "DD_AGENT_TEST_WEBHOOK" } } as AgentConfig;
  assert.equal(await postNotification(config, "hello"), false);
});

test("notifyBudgetWarning: returns null while inside limits, warning text when low", async () => {
  const config = { ...base, budget: { ...base.budget, warnRemainingUsd: 5 } } as unknown as AgentConfig;
  const ok = await notifyBudgetWarning(config, { limit: 25, remaining: 16, usage: 9, usageDaily: 5 });
  assert.equal(ok, null);
  const warning = await notifyBudgetWarning(config, { limit: 25, remaining: 2, usage: 23, usageDaily: 5 });
  assert.match(warning ?? "", /only \$2\.00 left/);
});
