const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class CpaHttpQueueError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CpaHttpQueueError";
    this.code = options.code ?? "CPA_HTTP_QUEUE_ERROR";
    this.status = options.status;
    this.uncertainConsumption = options.uncertainConsumption ?? false;
  }
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CpaHttpQueueError(
          "CPA HTTP Usage Queue response exceeded the configured size limit",
          { code: "CPA_HTTP_RESPONSE_TOO_LARGE", uncertainConsumption: true }
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function pullUsageViaHttp({
  baseUrl,
  managementKey,
  count = 100,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
}) {
  if (!managementKey) throw new Error("CPA management key is required for HTTP queue access");
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new RangeError("HTTP batch count must be between 1 and 1000");
  }

  let url;
  try {
    url = new URL("/v8/management/observability/usage/queue", baseUrl);
  } catch {
    throw new TypeError("CPA_MANAGEMENT_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("CPA management URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("CPA management URL must not embed credentials, query parameters or fragments");
  }
  url.searchParams.set("count", String(count));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        Accept: "application/json"
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new CpaHttpQueueError(
        `CPA HTTP Usage Queue returned HTTP ${response.status}`,
        {
          code: "CPA_HTTP_STATUS_ERROR",
          status: response.status,
          uncertainConsumption: response.status === 408 || response.status >= 500
        }
      );
    }

    let body;
    try {
      body = await readBoundedBody(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof CpaHttpQueueError) throw error;
      throw new CpaHttpQueueError("CPA HTTP Usage Queue response body could not be read", {
        code: "CPA_HTTP_BODY_READ_ERROR",
        uncertainConsumption: true
      });
    }

    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new CpaHttpQueueError("CPA HTTP Usage Queue returned invalid JSON", {
        code: "CPA_HTTP_INVALID_JSON",
        uncertainConsumption: true
      });
    }

    if (!Array.isArray(payload)) {
      throw new CpaHttpQueueError("CPA HTTP Usage Queue response must be a JSON array", {
        code: "CPA_HTTP_INVALID_SHAPE",
        uncertainConsumption: true
      });
    }

    return payload;
  } catch (error) {
    if (error instanceof CpaHttpQueueError) throw error;
    const isTimeout = error instanceof Error && error.name === "AbortError";
    throw new CpaHttpQueueError(
      isTimeout ? "CPA HTTP Usage Queue request timed out" : "CPA HTTP Usage Queue request failed",
      {
        code: isTimeout ? "CPA_HTTP_TIMEOUT" : "CPA_HTTP_NETWORK_ERROR",
        uncertainConsumption: true
      }
    );
  } finally {
    clearTimeout(timer);
  }
}
