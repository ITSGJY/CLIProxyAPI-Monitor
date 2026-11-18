import net from "node:net";

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_BULK_LENGTH = 64 * 1024;

export function parseRespAddress(address) {
  if (typeof address !== "string" || !address.trim()) {
    throw new TypeError("CPA_REDIS_ADDR is required");
  }

  const value = address.trim();
  const match = value.startsWith("[")
    ? value.match(/^\[([^\]]+)\]:(\d+)$/)
    : value.match(/^([^:]+):(\d+)$/);

  if (!match) throw new TypeError("CPA_REDIS_ADDR must be host:port or [ipv6]:port");

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("CPA_REDIS_ADDR contains an invalid port");
  }

  return { host: match[1], port };
}

export function encodeRespCommand(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError("RESP command must contain at least one argument");
  }

  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = Buffer.from(String(arg), "utf8");
    parts.push(`$${value.length}\r\n`, value, "\r\n");
  }
  return Buffer.concat(parts.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
}

export function parseRespFrame(buffer, offset = 0, depth = 0) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("RESP input must be a Buffer");
  if (offset >= buffer.length) return null;
  if (depth > 8) throw new Error("RESP nesting limit exceeded");

  const prefix = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset + 1);
  if (lineEnd < 0) return null;

  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  if (prefix === "+") return { value: line, next };
  if (prefix === "-") return { error: new Error(line || "CPA RESP command failed"), next };

  if (prefix === ":") {
    const value = Number(line);
    if (!Number.isSafeInteger(value)) throw new Error("Invalid RESP integer");
    return { value, next };
  }

  if (prefix === "$") {
    const length = Number(line);
    if (!Number.isInteger(length) || length < -1 || length > MAX_BULK_LENGTH) {
      throw new Error("Invalid RESP bulk string length");
    }
    if (length === -1) return { value: null, next };
    if (buffer.length < next + length + 2) return null;
    if (buffer[next + length] !== 13 || buffer[next + length + 1] !== 10) {
      throw new Error("Malformed RESP bulk string terminator");
    }
    return {
      value: buffer.toString("utf8", next, next + length),
      next: next + length + 2
    };
  }

  if (prefix === "*") {
    const count = Number(line);
    if (!Number.isInteger(count) || count < -1 || count > MAX_ARRAY_LENGTH) {
      throw new Error("Invalid RESP array length");
    }
    if (count === -1) return { value: null, next };

    const values = [];
    let cursor = next;
    for (let index = 0; index < count; index += 1) {
      const item = parseRespFrame(buffer, cursor, depth + 1);
      if (!item) return null;
      if (item.error) return item;
      values.push(item.value);
      cursor = item.next;
    }
    return { value: values, next: cursor };
  }

  throw new Error(`Unsupported RESP prefix: ${prefix}`);
}

class RespClient {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.failure = null;
    this.busy = false;
    this.closed = false;
    this.pushHandler = null;

    socket.on("data", (chunk) => {
      if (this.failure || this.closed) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > this.maxResponseBytes) {
        this.fail(new Error("CPA RESP response exceeded the configured size limit"));
        socket.destroy();
        return;
      }
      this.flush();
    });

    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (!this.closed) this.fail(new Error("CPA RESP connection closed"));
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  setPushHandler(handler) {
    this.pushHandler = handler;
    this.flush();
  }

  flush() {
    while (this.waiters.length > 0 || (this.pushHandler && this.buffer.length > 0)) {
      let parsed;
      try {
        parsed = parseRespFrame(this.buffer);
      } catch (error) {
        this.fail(error);
        return;
      }
      if (!parsed) return;

      this.buffer = this.buffer.subarray(parsed.next);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        if (parsed.error) {
          parsed.error.respServerError = true;
          waiter.reject(parsed.error);
        } else waiter.resolve(parsed.value);
      } else if (this.pushHandler) {
        if (parsed.error) {
          this.fail(parsed.error);
          return;
        }
        try {
          this.pushHandler(parsed.value);
        } catch (error) {
          this.fail(error);
          this.socket.destroy();
          return;
        }
      }
    }
  }

  readValue() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("CPA RESP connection is closed"));

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("CPA RESP response timed out"));
        }, this.timeoutMs)
      };
      this.waiters.push(waiter);
      this.flush();
    });
  }

  async command(...args) {
    if (this.busy) throw new Error("Concurrent commands on one CPA RESP connection are not supported");
    if (this.failure) throw this.failure;
    if (this.closed || this.socket.destroyed) throw new Error("CPA RESP connection is closed");

    this.busy = true;
    try {
      this.socket.write(encodeRespCommand(args));
      return await this.readValue();
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CPA RESP connection closed"));
    }
    if (!this.socket.destroyed) this.socket.end();
  }
}

export async function connectRespClient({
  address,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
}) {
  if (!password) throw new Error("CPA management key is required for RESP AUTH");
  const { host, port } = parseRespAddress(address);
  const socket = net.createConnection({ host, port });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("CPA RESP connection timed out"));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const client = new RespClient(socket, { timeoutMs, maxResponseBytes });
  try {
    let authResult;
    try {
      authResult = await client.command("AUTH", password);
    } catch (error) {
      error.respAuthError = true;
      throw error;
    }
    if (authResult !== "OK") {
      const error = new Error("CPA RESP AUTH was not accepted");
      error.respAuthError = true;
      throw error;
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function pullUsageViaResp({
  address,
  password,
  queue = "usage",
  count = 100,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (queue !== "usage") throw new Error("CPA v8 Usage Queue must use the 'usage' channel");
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new RangeError("RESP batch count must be between 1 and 1000");
  }

  const client = await connectRespClient({ address, password, timeoutMs });
  try {
    let result;
    try {
      result = await client.command("LPOP", queue, String(count));
    } catch (error) {
      if (!error?.respServerError) error.uncertainConsumption = true;
      throw error;
    }
    if (result === null) return [];
    if (!Array.isArray(result)) {
      const error = new Error("CPA RESP LPOP did not return an array");
      error.uncertainConsumption = true;
      throw error;
    }
    if (!result.every((item) => typeof item === "string")) {
      const error = new Error("CPA RESP LPOP returned a non-string usage item");
      error.uncertainConsumption = true;
      throw error;
    }
    return result;
  } finally {
    client.close();
  }
}


/**
 * Subscribe to CPA's native Redis Pub/Sub usage stream. CPA does not enqueue
 * usage events while any subscriber exists, so this connection must remain
 * healthy for the lifetime of the subscription. A disconnect is therefore
 * an explicit at-most-once ingestion gap, not a signal to blindly LPOP.
 */
export async function subscribeUsageViaResp({
  address,
  password,
  channel = "usage",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  onMessage,
  onSubscribed
}) {
  if (channel !== "usage") throw new Error("CPA v8 RESP subscription must use the 'usage' channel");
  if (typeof onMessage !== "function") throw new TypeError("onMessage callback is required");
  if (signal?.aborted) return { clean: true, messages: 0 };

  const client = await connectRespClient({ address, password, timeoutMs });
  let messages = 0;
  let pendingMessages = 0;
  let processing = Promise.resolve();
  let settled = false;
  const MAX_PENDING_MESSAGES = 1_000;
  const PAUSE_AT_MESSAGES = 100;
  const RESUME_AT_MESSAGES = 25;
  let abortHandler;

  try {
    client.setPushHandler((frame) => {
      if (!Array.isArray(frame) || frame.length !== 3) {
        throw new Error("CPA RESP subscription returned an invalid Pub/Sub frame");
      }
      const [kind, receivedChannel, payload] = frame;
      if (kind !== "message" || receivedChannel !== channel || typeof payload !== "string") {
        // Ignore subscription control acknowledgements and unrelated messages.
        return;
      }
      messages += 1;
      pendingMessages += 1;
      if (pendingMessages > MAX_PENDING_MESSAGES) {
        const error = new Error("CPA RESP subscription exceeded the bounded Inbox persistence backlog");
        error.subscriptionEstablished = true;
        client.subscriptionFailure = error;
        throw error;
      }
      if (pendingMessages >= PAUSE_AT_MESSAGES) client.socket.pause();
      processing = processing.then(async () => {
        try {
          await onMessage(payload);
        } finally {
          pendingMessages -= 1;
          if (pendingMessages <= RESUME_AT_MESSAGES && !client.socket.destroyed) client.socket.resume();
        }
      });
      processing.catch((error) => {
        client.subscriptionFailure = error;
        client.socket.destroy(error);
      });
    });

    let acknowledgement;
    try {
      acknowledgement = await client.command("SUBSCRIBE", channel);
    } catch (error) {
      if (error?.respServerError) error.respSubscribeRejected = true;
      throw error;
    }
    if (!Array.isArray(acknowledgement) || acknowledgement[0] !== "subscribe" || acknowledgement[1] !== channel) {
      const error = new Error("CPA RESP SUBSCRIBE acknowledgement was invalid");
      error.respServerError = true;
      error.respSubscribeRejected = true;
      throw error;
    }
    if (typeof onSubscribed === "function") {
      try {
        await onSubscribed();
        if (client.failure || client.socket.destroyed) {
          const error = client.failure || new Error("CPA RESP subscription disconnected during startup");
          error.subscriptionEstablished = true;
          throw error;
        }
      } catch (error) {
        error.subscriptionEstablished = true;
        client.subscriptionFailure = error;
        client.socket.destroy(error);
        throw error;
      }
    }

    const closed = new Promise((resolve, reject) => {
      const onClose = () => {
        if (settled) return;
        settled = true;
        const error = client.subscriptionFailure || new Error("CPA RESP subscription disconnected");
        error.subscriptionEstablished = true;
        reject(error);
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        error.subscriptionEstablished = true;
        reject(error);
      };
      client.socket.once("close", onClose);
      client.socket.once("error", onError);
      abortHandler = async () => {
        if (settled) return;
        settled = true;
        try {
          await client.command("UNSUBSCRIBE", channel);
          await processing;
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) void abortHandler();
    });

    await closed;
    await processing;
    return { clean: true, messages };
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    client.close();
  }
}
