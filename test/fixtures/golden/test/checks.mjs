/**
 * Real tests, run by `npm test` with the node built-in runner and no deps.
 *
 * Named `checks.mjs` rather than `*.test.mjs` deliberately: Dispatched Code's
 * own suite globs for test files, and a fixture whose tests get collected by the
 * outer runner is a fixture that breaks the build it is meant to support.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { mean, median, sum } from "../src/stats.js";

test("sum adds the list", () => {
  assert.equal(sum([1, 2, 3, 4]), 10);
  assert.equal(sum([]), 0);
});

test("mean divides by the count", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.throws(() => mean([]), RangeError);
});

test("median handles both parities", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), RangeError);
});
