import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getUsageRecords, type SortField, type SortKey } from "@/lib/queries/records";
import { parseRecordsFilters, RecordsFilterError } from "@/lib/records-filters";

export const runtime = "nodejs";

const VALID_SORT_FIELDS = new Set<SortField>([
  "occurredAt", "model", "route", "source", "provider", "requestId",
  "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cachedTokens",
  "cacheReadTokens", "cacheCreationTokens", "latencyMs", "ttftMs", "cost", "isError",
  "sessionId", "parentSessionId", "executionId", "traceId", "nodeKind", "isFork", "isCompaction"
]);

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    let sortKeys: SortKey[] | undefined;
    const sortParam = searchParams.get("sort");
    if (sortParam) {
      const parsed = sortParam.split(",").map((part) => {
        const [field, order] = part.split(":");
        return { field: (field ?? "").trim(), order: (order ?? "desc").trim() };
      }).filter((item) => VALID_SORT_FIELDS.has(item.field as SortField) && (item.order === "asc" || item.order === "desc")) as SortKey[];
      if (parsed.length > 0) sortKeys = parsed;
    }

    const legacySortField = searchParams.get("sortField");
    const legacySortOrder = searchParams.get("sortOrder");
    const sortField = !sortKeys && legacySortField && VALID_SORT_FIELDS.has(legacySortField as SortField)
      ? legacySortField as SortField
      : undefined;
    const sortOrder = !sortKeys && (legacySortOrder === "asc" || legacySortOrder === "desc") ? legacySortOrder : undefined;
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    if (limitParam && (!Number.isInteger(limit) || (limit ?? 0) < 1)) {
      return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
    }

    const filters = parseRecordsFilters(searchParams);
    const payload = await getUsageRecords({
      ...filters,
      limit,
      sortKeys,
      sortField,
      sortOrder,
      cursor: searchParams.get("cursor"),
      includeFilters: searchParams.get("includeFilters") === "1"
    });
    return NextResponse.json(payload, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RecordsFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("/api/records failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
