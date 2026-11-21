import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getUsageRecordsForExport } from "@/lib/queries/records";
import { parseRecordsFilters, RecordsFilterError } from "@/lib/records-filters";

export const runtime = "nodejs";

const EXPORT_LIMIT = 20000;
const EXPORT_COLUMNS: Array<[string, string]> = [
  ["timestamp", "occurredAt"], ["status", "isError"], ["request_id", "requestId"],
  ["provider", "provider"], ["api_group", "apiGroupLabel"], ["api_group_key", "apiGroupKey"],
  ["api_key_mask", "route"], ["credential", "credentialName"], ["model", "model"],
  ["model_alias", "modelAlias"], ["response_model", "responseModel"], ["endpoint", "endpoint"],
  ["auth_type", "authType"], ["executor_type", "executorType"], ["reasoning_effort", "reasoningEffort"],
  ["service_tier", "serviceTier"], ["stream", "stream"], ["generate", "generate"],
  ["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["reasoning_tokens", "reasoningTokens"],
  ["cached_tokens", "cachedTokens"], ["cache_read_tokens", "cacheReadTokens"],
  ["cache_creation_tokens", "cacheCreationTokens"], ["total_tokens", "totalTokens"],
  ["latency_ms", "latencyMs"], ["ttft_ms", "ttftMs"], ["http_status", "statusCode"],
  ["fail_code", "failCode"], ["cost", "cost"], ["currency", "costCurrency"],
  ["pricing_status", "pricingStatus"], ["session_id", "sessionId"],
  ["parent_session_id", "parentSessionId"], ["execution_id", "executionId"],
  ["trace_id", "traceId"], ["node_kind", "nodeKind"], ["is_fork", "isFork"],
  ["is_compaction", "isCompaction"], ["token_accounting", "tokenAccounting"],
  ["structured_usage", "structuredUsage"], ["response_headers", "responseHeaders"]
];

function csvValue(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const format = searchParams.get("format") ?? "csv";
    if (format !== "csv" && format !== "json") {
      return NextResponse.json({ error: "format must be csv or json" }, { status: 400 });
    }
    const filters = parseRecordsFilters(searchParams);
    const result = await getUsageRecordsForExport(filters, EXPORT_LIMIT);
    const filename = `monitor-records-${new Date().toISOString().slice(0, 10)}.${format}`;

    if (format === "json") {
      return new NextResponse(JSON.stringify({
        exportedAt: new Date().toISOString(),
        count: result.items.length,
        truncated: result.truncated,
        limit: EXPORT_LIMIT,
        items: result.items
      }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Records-Truncated": result.truncated ? "true" : "false"
        }
      });
    }

    const header = EXPORT_COLUMNS.map(([label]) => csvValue(label)).join(",");
    const lines = result.items.map((item: any) => EXPORT_COLUMNS.map(([, key]) => {
      if (key === "isError") return csvValue(item.isError ? "error" : "success");
      return csvValue(item[key]);
    }).join(","));
    const csv = ["\uFEFF" + header, ...lines].join("\r\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Records-Truncated": result.truncated ? "true" : "false"
      }
    });
  } catch (error) {
    if (error instanceof RecordsFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("/api/records/export failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
