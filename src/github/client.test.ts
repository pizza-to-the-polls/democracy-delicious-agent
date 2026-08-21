import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClosingRefs } from "./client.js";

test("extractClosingRefs finds all closing keyword variants", () => {
  const body = "Closes #1, fixes #2, resolves #3, close #4, fixed #5, resolved #6";
  assert.deepEqual(extractClosingRefs(body), [1, 2, 3, 4, 5, 6]);
});

test("extractClosingRefs deduplicates and preserves first-seen order", () => {
  assert.deepEqual(extractClosingRefs("fixes #7 then closes #7 and fixes #9"), [7, 9]);
});

test("extractClosingRefs ignores non-closing references", () => {
  assert.deepEqual(extractClosingRefs("Implements #10, related to #11, closes #12"), [12]);
});

test("extractClosingRefs handles null and empty bodies", () => {
  assert.deepEqual(extractClosingRefs(null), []);
  assert.deepEqual(extractClosingRefs(""), []);
});
