import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { encodeRespCommand, parseRespFrame, pullUsageViaResp, subscribeUsageViaResp } from "../../lib/collector/resp-client.mjs";

function readRequest(buffer) {
  const firstLineEnd = buffer.indexOf("\r\n");
  if (firstLineEnd < 0) return null;
  const count = Number(buffer.toString("utf8", 1, firstLineEnd));
  if (!Number.isInteger(count) || count < 1) throw new Error("bad test RESP array");
  let cursor = firstLineEnd + 2;
  const args = [];
  for (let index = 0; index < count; index += 1) {
    const lineEnd = buffer.indexOf("\r\n", cursor);
    if (lineEnd < 0) return null;
    const length = Number(buffer.toString("utf8", cursor + 1, lineEnd));
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.toString("utf8", start, start + length));
    cursor = start + length + 2;
  }
  return { args, next: cursor };
}

test("RESP command encoder emits a RESP2 array of bulk strings", () => {
  const encoded = encodeRespCommand(["LPOP", "usage", "100"]).toString("utf8");
  assert.equal(encoded, "*3\r\n$4\r\nLPOP\r\n$5\r\nusage\r\n$3\r\n100\r\n");
});

test("RESP parser handles an array of usage payloads", () => {
  const frame = Buffer.from("*2\r\n$3\r\none\r\n$3\r\ntwo\r\n");
  const parsed = parseRespFrame(frame);
  assert.deepEqual(parsed.value, ["one", "two"]);
  assert.equal(parsed.next, frame.length);
});

test("CPA v8 RESP pull authenticates and consumes only the usage channel", async (t) => {
  const observed = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        observed.push(request.args);
        if (request.args[0] === "AUTH") {
          socket.write("+OK\r\n");
        } else if (request.args[0] === "LPOP") {
          const payload = JSON.stringify({ timestamp: "2026-11-17T00:00:00Z", model: "test-model" });
          socket.write("*1\r\n$" + Buffer.byteLength(payload) + "\r\n" + payload + "\r\n");
        } else {
          socket.write("-ERR unsupported command\r\n");
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const records = await pullUsageViaResp({
    address: "127.0.0.1:" + address.port,
    password: "test-management-key",
    queue: "usage",
    count: 100
  });

  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).model, "test-model");
  assert.deepEqual(observed.map((args) => args[0]), ["AUTH", "LPOP"]);
  assert.deepEqual(observed[1], ["LPOP", "usage", "100"]);
});

test("RESP LPOP with count returns an empty array when the CPA usage queue is empty", async (t) => {
  const observed = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        observed.push(request.args);
        if (request.args[0] === "AUTH") socket.write("+OK\r\n");
        else if (request.args[0] === "LPOP") socket.write("*0\r\n");
        else socket.write("-ERR unknown command\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const records = await pullUsageViaResp({
    address: "127.0.0.1:" + address.port,
    password: "test-management-key",
    queue: "usage",
    count: 100
  });
  assert.deepEqual(records, []);
  assert.deepEqual(observed, [["AUTH", "test-management-key"], ["LPOP", "usage", "100"]]);
});

test("RESP LPOP disconnect after command send is marked as uncertain consumption", async (t) => {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        if (request.args[0] === "AUTH") socket.write("+OK\r\n");
        else if (request.args[0] === "LPOP") socket.destroy();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  await assert.rejects(
    pullUsageViaResp({ address: "127.0.0.1:" + address.port, password: "test-key" }),
    (error) => error.uncertainConsumption === true
  );
});

test("RESP server command errors are safe to fall back from", async (t) => {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        if (request.args[0] === "AUTH") socket.write("+OK\r\n");
        else if (request.args[0] === "LPOP") socket.write("-WRONGTYPE usage is not a list\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  await assert.rejects(
    pullUsageViaResp({ address: "127.0.0.1:" + address.port, password: "test-key" }),
    (error) => error.respServerError === true && !error.uncertainConsumption
  );
});

test("RESP pull rejects a non-usage channel", async () => {
  await assert.rejects(
    pullUsageViaResp({
      address: "127.0.0.1:12345",
      password: "test",
      queue: "queue",
      count: 10
    }),
    /must use the 'usage' channel/
  );
});


test("CPA RESP subscription authenticates, subscribes to usage and durably forwards Pub/Sub messages", async (t) => {
  const observed = [];
  let socketRef;
  const server = createServer((socket) => {
    socketRef = socket;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        observed.push(request.args);
        if (request.args[0] === "AUTH") socket.write("+OK\r\n");
        else if (request.args[0] === "SUBSCRIBE") {
          socket.write("*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n");
          const frames = [];
          for (let index = 0; index < 150; index += 1) {
            const payload = JSON.stringify({ request_id: `subscription-event-${index}`, model: "test-model" });
            frames.push("*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$" + Buffer.byteLength(payload) + "\r\n" + payload + "\r\n");
          }
          setImmediate(() => socket.write(frames.join("")));
        } else if (request.args[0] === "UNSUBSCRIBE") {
          socket.write("*3\r\n$11\r\nunsubscribe\r\n$5\r\nusage\r\n:0\r\n");
        } else socket.write("-ERR unsupported command\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { socketRef?.destroy(); server.close(resolve); }));
  const address = server.address();
  const controller = new AbortController();
  const received = [];
  let activeCallbacks = 0;
  let maxActiveCallbacks = 0;
  const running = subscribeUsageViaResp({
    address: `127.0.0.1:${address.port}`,
    password: "test-management-key",
    signal: controller.signal,
    onMessage: async (payload) => {
      activeCallbacks += 1;
      maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
      await new Promise((resolve) => setTimeout(resolve, 1));
      received.push(JSON.parse(payload));
      activeCallbacks -= 1;
    }
  });
  for (let i = 0; i < 1_000 && received.length < 150; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.length, 150);
  assert.equal(received[0].request_id, "subscription-event-0");
  assert.equal(received[149].request_id, "subscription-event-149");
  assert.equal(maxActiveCallbacks, 1);
  controller.abort();
  const result = await running;
  assert.equal(result.clean, true);
  assert.equal(result.messages, 150);
  assert.deepEqual(observed.map((args) => args[0]), ["AUTH", "SUBSCRIBE", "UNSUBSCRIBE"]);
  assert.deepEqual(observed[1], ["SUBSCRIBE", "usage"]);
});

test("RESP subscription marks an explicit server rejection so auto mode can safely select pull", async (t) => {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        if (request.args[0] === "AUTH") socket.write("+OK\r\n");
        else if (request.args[0] === "SUBSCRIBE") socket.write("-ERR unknown command 'SUBSCRIBE'\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  await assert.rejects(
    subscribeUsageViaResp({ address: `127.0.0.1:${address.port}`, password: "test-key", onMessage() {} }),
    (error) => error.respSubscribeRejected === true && error.subscriptionEstablished !== true
  );
});

test("RESP subscription disconnect after acknowledgement is marked as an established stream", async (t) => {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const request = readRequest(buffer);
        if (!request) break;
        buffer = buffer.subarray(request.next);
        if (request.args[0] === "AUTH") socket.write("+OK\r\n");
        else if (request.args[0] === "SUBSCRIBE") {
          socket.write("*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n");
          setTimeout(() => socket.destroy(), 10);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  await assert.rejects(
    subscribeUsageViaResp({ address: `127.0.0.1:${address.port}`, password: "test-key", onMessage() {} }),
    (error) => error.subscriptionEstablished === true
  );
});
