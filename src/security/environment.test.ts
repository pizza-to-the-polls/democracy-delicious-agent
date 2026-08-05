import assert from "node:assert/strict";
import test from "node:test";
import { sanitizedWorkerEnvironment } from "./environment.js";

test("sanitizedWorkerEnvironment strips common credential variables", () => {
  const original = { ...process.env };
  process.env.OPENROUTER_API_KEY = "secret";
  process.env.AWS_ACCESS_KEY_ID = "secret";
  process.env.GH_TOKEN = "secret";
  process.env.STRIPE_SECRET_KEY = "secret";
  process.env.SAFE_TEST_VALUE = "visible";
  try {
    const env = sanitizedWorkerEnvironment();
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
    assert.equal(env.SAFE_TEST_VALUE, "visible");
    assert.equal(env.CI, "1");
  } finally {
    process.env = original;
  }
});
