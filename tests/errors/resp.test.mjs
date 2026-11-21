import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeErrorsViaResp, subscribeUsageViaResp, pullUsageViaResp } from "../../lib/collector/resp-client.mjs";
import { respFixture, frame, ack, eventually } from "./resp-fixture.mjs";

test("errors and usage authenticate/acknowledge on two independent RESP connections; error outage leaves usage alive", async (t) => {
  const channels = new Map();
  const server = await respFixture(t, (socket, args) => {
    channels.set(args[1], socket);
    socket.write(ack("subscribe", args[1], 1));
  });
  const usageStop = new AbortController(), errorsStop = new AbortController();
  const usage = [], errors = [];
  let usageAck = false, errorAck = false;
  const common = { address: server.address, password: "test-key" };
  const runningUsage = subscribeUsageViaResp({ ...common, signal: usageStop.signal, onSubscribed: () => { usageAck = true; }, onMessage: (p) => usage.push(p) });
  const runningErrors = subscribeErrorsViaResp({ ...common, signal: errorsStop.signal, onSubscribed: async () => { await new Promise((r) => setTimeout(r, 10)); errorAck = true; }, onMessage: (p) => { assert.ok(errorAck); errors.push(p); } });
  const rejection = assert.rejects(runningErrors);
  await eventually(() => usageAck && errorAck);
  assert.notEqual(channels.get("usage"), channels.get("errors"));
  assert.equal(server.commands.filter((c) => c.args[0] === "AUTH").length, 2);
  channels.get("errors").write(frame("message", "errors", "first-error"));
  await eventually(() => errors.length === 1);
  channels.get("errors").destroy();
  await rejection;
  channels.get("usage").write(frame("message", "usage", "usage-survives"));
  await eventually(() => usage.length === 1);
  assert.deepEqual(usage, ["usage-survives"]);
  usageStop.abort();
  assert.equal((await runningUsage).clean, true);
  assert.ok(!server.commands.some((c) => c.args[0] === "LPOP"));
  await assert.rejects(subscribeUsageViaResp({ ...common, channel: "errors", onMessage() {} }), /usage/);
  await assert.rejects(pullUsageViaResp({ ...common, queue: "errors" }), /usage/);
  await assert.rejects(subscribeErrorsViaResp({ ...common, channel: "usage", onMessage() {} }), /errors/);
});

test("errors reject invalid acknowledgements before any callback and never log raw server text", async (t) => {
  const server = await respFixture(t, (socket) => socket.write(ack("subscribe", "usage", 1)));
  let called = false;
  await assert.rejects(subscribeErrorsViaResp({ address: server.address, password: "test-key", onMessage() {}, onSubscribed: () => { called = true; } }));
  assert.equal(called, false);
});

test("coalesced message frames wait for subscription persistence; graceful shutdown drains accepted callbacks", async (t) => {
  const server = await respFixture(t, (socket) => socket.write(Buffer.concat([ack("subscribe", "errors", 1), frame("message", "errors", "one"), frame("message", "errors", "two")])));
  const controller = new AbortController();
  let subscribed = false, active = 0, maxActive = 0;
  const received = [];
  const run = subscribeErrorsViaResp({ address: server.address, password: "test-key", signal: controller.signal,
    onSubscribed: async () => { await new Promise((r) => setTimeout(r, 10)); subscribed = true; },
    onMessage: async (p, receivedAt) => { assert.ok(subscribed); assert.ok(receivedAt instanceof Date); assert.ok(receivedAt.getTime() <= Date.now()); maxActive = Math.max(maxActive, ++active); await new Promise((r) => setTimeout(r, 15)); received.push(p); active--; controller.abort(); }
  });
  assert.equal((await run).clean, true);
  assert.deepEqual(received, ["one", "two"]);
  assert.equal(maxActive, 1);
});

test("error backlog has bounded count/bytes and fails with an explicit gap trigger", async (t) => {
  const server = await respFixture(t, (socket) => socket.write(Buffer.concat([ack("subscribe", "errors", 1), ...Array.from({ length: 20 }, () => frame("message", "errors", "payload"))])));
  let received = 0;
  await assert.rejects(subscribeErrorsViaResp({ address: server.address, password: "test-key", maxPending: 3, maxPendingBytes: 100,
    onMessage: async () => { await new Promise((r) => setTimeout(r, 10)); received++; }
  }), /backpressure/);
  assert.ok(received <= 3);
});

test("PONG coverage follows prior durable callbacks; no message is mistaken for a command acknowledgement", async (t) => {
  const server = await respFixture(t, (socket) => socket.write(Buffer.concat([ack("subscribe", "errors", 1), frame("message", "errors", "e")])));
  const stop = new AbortController();
  let persisted = false, confirmed = false;
  await subscribeErrorsViaResp({ address: server.address, password: "test-key", signal: stop.signal, heartbeatMs: 10, timeoutMs: 100,
    onMessage: async () => { await new Promise((r) => setTimeout(r, 20)); persisted = true; },
    onHeartbeat: () => { assert.ok(persisted); confirmed = true; stop.abort(); }
  });
  assert.ok(confirmed);
});

test("malformed RESP and oversized error bulk frames terminate the error stream", async (t) => {
  for (const malformed of [Buffer.from("*3\r\n$7\r\nmessage\r\n$6\r\nerrors\r\n$999999\r\n"), frame("unexpected", "errors", "private")]) {
    const server = await respFixture(t, (socket) => socket.write(Buffer.concat([ack("subscribe", "errors", 1), malformed])));
    await assert.rejects(subscribeErrorsViaResp({ address: server.address, password: "test-key", onMessage() { assert.fail("malformed frames must not enter persistence"); } }));
  }
});

test("shutdown is bounded when persistence stalls", async (t) => {
  const server = await respFixture(t, (socket) => socket.write(Buffer.concat([ack("subscribe", "errors", 1), frame("message", "errors", "blocked")])));
  const stop = new AbortController();
  await assert.rejects(subscribeErrorsViaResp({ address: server.address, password: "test-key", signal: stop.signal, drainTimeoutMs: 20,
    onMessage: () => { stop.abort(); return new Promise(() => {}); }
  }), /drain_timeout/);
});
