import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { expandHome } from "./config.js";

test("expandHome expands a home-relative path", () => {
  assert.equal(expandHome("~/.config/example"), `${homedir()}/.config/example`);
});

test("expandHome returns the home directory for tilde", () => {
  assert.equal(expandHome("~"), homedir());
});
