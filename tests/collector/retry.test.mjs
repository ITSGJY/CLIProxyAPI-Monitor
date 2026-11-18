import assert from "node:assert/strict";
import { test } from "node:test";
import { getPullBackoffMs, MAX_PULL_BACKOFF_MS } from "../../lib/collector/retry.mjs";

test("pull retry backoff grows exponentially and is capped", () => {
  assert.equal(getPullBackoffMs(1, 10_000), 20_000);
  assert.equal(getPullBackoffMs(2, 10_000), MAX_PULL_BACKOFF_MS);
  assert.equal(getPullBackoffMs(5, 1_000), 30_000);
  assert.equal(getPullBackoffMs(0, 1_000), 2_000);
});
