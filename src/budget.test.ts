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
