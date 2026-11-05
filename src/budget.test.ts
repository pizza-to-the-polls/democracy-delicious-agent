import assert from "node:assert/strict";
import test from "node:test";
import { assertBudgetAvailable } from "./budget.js";

const limits = { dailyUsd: 15, autonomousStopUsd: 350, absoluteUsd: 400 };

test("allows work below all authoritative budget limits", () => {
  assert.doesNotThrow(() => assertBudgetAvailable({ limit: 25, remaining: 16, usage: 9, usageDaily: 9 }, limits));
});

test("stops at the daily OpenRouter usage limit", () => {
  assert.throws(
    () => assertBudgetAvailable({ limit: 25, remaining: 10, usage: 15, usageDaily: 15 }, limits),
    /daily usage/,
  );
});

test("keeps a provider-side reserve", () => {
  assert.throws(
    () => assertBudgetAvailable({ limit: 25, remaining: 0.5, usage: 24.5, usageDaily: 5 }, limits),
    /reserve required/,
  );
});

import { budgetWarning } from "./budget.js";

test("budgetWarning: silent while comfortably inside limits", () => {
  assert.strictEqual(budgetWarning({ limit: 25, remaining: 16, usage: 9, usageDaily: 5 }, limits), null);
});

test("budgetWarning: fires at 80% of the daily limit", () => {
  const warning = budgetWarning({ limit: 25, remaining: 10, usage: 12, usageDaily: 12.5 }, limits);
  assert.match(warning ?? "", /daily usage/);
});

test("budgetWarning: fires when the key is nearly out of credit", () => {
  const low = budgetWarning({ limit: 25, remaining: 2, usage: 23, usageDaily: 5 }, limits, 5);
  assert.match(low ?? "", /only \$2\.00 left/);
});

test("budgetWarning: no remaining-credit warning when the key has no limit", () => {
  assert.strictEqual(budgetWarning({ limit: null, remaining: null, usage: 9, usageDaily: 5 }, limits), null);
});
