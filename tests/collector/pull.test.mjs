import assert from "node:assert/strict";
import { test } from "node:test";
import { pullUsageBatch } from "../../lib/collector/pull.mjs";

test("RESP is preferred and an empty successful pull does not trigger HTTP", async () => {
  let httpCalls = 0;
  const result = await pullUsageBatch({
    pullResp: async () => [],
    pullHttp: async () => { httpCalls += 1; return [{ model: "fallback" }]; },
    count: 20
  });

  assert.equal(result.transport, "resp");
  assert.deepEqual(result.items, []);
  assert.equal(httpCalls, 0);
});

test("HTTP is used only after a RESP transport failure", async () => {
  const result = await pullUsageBatch({
    pullResp: async () => { throw new Error("connection refused"); },
    pullHttp: async () => [{ model: "fallback" }],
    count: 20
  });

  assert.equal(result.transport, "http");
  assert.equal(result.items[0].model, "fallback");
  assert.match(result.fallbackReason, /connection refused/);
});

test("both transport failures are surfaced together", async () => {
  await assert.rejects(
    pullUsageBatch({
      pullResp: async () => { throw new Error("resp failed"); },
      pullHttp: async () => { throw new Error("http failed"); },
      count: 20
    }),
    (error) => error.code === "CPA_USAGE_QUEUE_UNAVAILABLE" && error instanceof AggregateError
  );
});


test("HTTP fallback is forbidden after a possibly destructive RESP failure", async () => {
  let httpCalls = 0;
  await assert.rejects(
    pullUsageBatch({
      pullResp: async () => { const error = new Error("connection lost after LPOP"); error.uncertainConsumption = true; throw error; },
      pullHttp: async () => { httpCalls += 1; return []; },
      count: 20
    }),
    (error) => error.uncertainConsumption === true
  );
  assert.equal(httpCalls, 0);
});
