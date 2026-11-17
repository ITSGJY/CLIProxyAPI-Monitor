function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .replace(/(api[_-]?key|secret|password|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 300);
}

export async function pullUsageBatch({ pullResp, pullHttp, count = 100 }) {
  if (typeof pullResp !== "function" || typeof pullHttp !== "function") {
    throw new TypeError("Both RESP and HTTP pull functions must be supplied");
  }

  try {
    const items = await pullResp(count);
    if (!Array.isArray(items)) throw new Error("RESP pull did not return an array");
    return { transport: "resp", items, fallbackReason: null };
  } catch (respError) {
    if (respError?.uncertainConsumption) {
      respError.code = respError.code ?? "CPA_USAGE_PULL_UNCERTAIN";
      throw respError;
    }
    try {
      const items = await pullHttp(count);
      if (!Array.isArray(items)) throw new Error("HTTP pull did not return an array");
      return {
        transport: "http",
        items,
        fallbackReason: safeErrorMessage(respError)
      };
    } catch (httpError) {
      const error = new AggregateError(
        [respError, httpError],
        `CPA Usage Queue unavailable over RESP and HTTP (RESP: ${safeErrorMessage(respError)}; HTTP: ${safeErrorMessage(httpError)})`
      );
      error.code = "CPA_USAGE_QUEUE_UNAVAILABLE";
      throw error;
    }
  }
}
