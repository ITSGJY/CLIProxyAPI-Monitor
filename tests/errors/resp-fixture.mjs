import { createServer } from "node:net";
import { encodeRespCommand, parseRespFrame } from "../../lib/collector/resp-client.mjs";

export const frame = (...parts) => encodeRespCommand(parts);
export const ack = (kind, channel, count) => Buffer.concat([Buffer.from("*3\r\n"), ...[kind, channel].map((v) => Buffer.from(`$${Buffer.byteLength(v)}\r\n${v}\r\n`)), Buffer.from(`:${count}\r\n`)]);
export async function respFixture(t, handle) {
  const sockets = new Set(), commands = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseRespFrame(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.next);
        const args = parsed.value;
        commands.push({ socket, args });
        if (args[0] === "AUTH") socket.write("+OK\r\n");
        else if (args[0] === "UNSUBSCRIBE") socket.write(ack("unsubscribe", args[1], 0));
        else if (args[0] === "PING") socket.write(frame("pong", args[1]));
        else handle(socket, args);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { address: `127.0.0.1:${server.address().port}`, commands, sockets };
}

export async function eventually(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
