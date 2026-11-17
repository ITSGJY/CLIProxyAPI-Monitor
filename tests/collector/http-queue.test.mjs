import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { pullUsageViaHttp } from "../../lib/collector/http-queue.mjs";

test("HTTP fallback requests the CPA v8 Usage Queue with management bearer auth", async (t) => {
  let observed;
  const server = createServer((request, response) => {
    observed = {
      url: request.url,
      authorization: request.headers.authorization,
      accept: request.headers.accept
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ timestamp: "2026-11-17T00:00:00Z", model: "http-model" }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const records = await pullUsageViaHttp({
    baseUrl: "http://127.0.0.1:" + address.port,
    managementKey: "test-management-key",
    count: 25
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].model, "http-model");
  assert.equal(observed.url, "/v8/management/observability/usage/queue?count=25");
  assert.equal(observed.authorization, "Bearer test-management-key");
  assert.equal(observed.accept, "application/json");
});

test("HTTP fallback reports authorization failures without exposing the key", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  await assert.rejects(
    pullUsageViaHttp({
      baseUrl: "http://127.0.0.1:" + address.port,
      managementKey: "do-not-print-this-key",
      count: 5
    }),
    (error) => error.status === 401 && !error.message.includes("do-not-print-this-key")
  );
});

test("HTTP fallback rejects a non-array response", async () => {
  await assert.rejects(
    pullUsageViaHttp({
      baseUrl: "http://127.0.0.1:12345",
      managementKey: "test",
      count: 5,
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    }),
    /must be a JSON array/
  );
});


test("HTTP 5xx after queue request is treated as uncertain consumption", async () => {
  await assert.rejects(
    pullUsageViaHttp({
      baseUrl: "http://127.0.0.1:12345",
      managementKey: "test",
      count: 5,
      fetchImpl: async () => new Response("server error", { status: 500 })
    }),
    (error) => error.status === 500 && error.uncertainConsumption === true
  );
});

test("oversized HTTP queue response is rejected and marked uncertain", async () => {
  await assert.rejects(
    pullUsageViaHttp({
      baseUrl: "http://127.0.0.1:12345",
      managementKey: "test",
      count: 5,
      maxResponseBytes: 4,
      fetchImpl: async () => new Response("[1,2,3,4,5]", { status: 200 })
    }),
    (error) => error.code === "CPA_HTTP_RESPONSE_TOO_LARGE" && error.uncertainConsumption === true
  );
});
