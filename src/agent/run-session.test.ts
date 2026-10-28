import test from "node:test";
import assert from "node:assert/strict";
import { isTransientModelError } from "./run-session.js";

test("isTransientModelError: stalls and rate limits are transient", () => {
  assert.equal(isTransientModelError("executor produced no text: terminated"), true);
  assert.equal(isTransientModelError("executor produced no text: Request timed out."), true);
  assert.equal(isTransientModelError('executor produced no text: 429: {"message":"Rate limit exceeded"}'), true);
  assert.equal(isTransientModelError("executor produced no text: upstream overloaded"), true);
  assert.equal(isTransientModelError("executor produced no text: connection error"), true);
});

test("isTransientModelError: budget and wall-clock errors surface, not fall back", () => {
  assert.equal(isTransientModelError('executor produced no text: 403: {"message":"Budget limit exceeded (weekly limit)"}'), false);
  assert.equal(isTransientModelError('executor produced no text: 402: {"message":"requires more credits"}'), false);
  assert.equal(isTransientModelError("reviewer exceeded 45 minute wall-clock limit"), false);
  assert.equal(isTransientModelError("executor produced no text: 400: maximum context length"), false);
  assert.equal(isTransientModelError(undefined), false);
});
