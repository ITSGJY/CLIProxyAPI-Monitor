import { NextResponse } from "next/server";
import { databasePool } from "@/lib/db/client";
import { getErrorCollectorHealth } from "@/lib/cpa-errors/query.mjs";

export const runtime = "nodejs";
export async function GET() {
  try {
    const instanceId = process.env.CPA_INSTANCE_ID;
    const health = !instanceId ? { healthy: false, status: "not_configured" }
      : process.env.ERROR_COLLECTOR_ENABLED === "false" ? { healthy: false, status: "disabled" }
      : await getErrorCollectorHealth(databasePool, instanceId);
    return NextResponse.json(health, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ healthy: false, status: "query_failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
