import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";
import { syncPricingCatalogs } from "@/lib/pricing/sync.mjs";

export const runtime = "nodejs";

const COOKIE_NAME = "dashboard_auth";

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function isAuthorized(request: Request) {
  const allowed = [config.password, config.cronSecret].filter(Boolean).map((value) => "Bearer " + value);
  if (allowed.some((value) => safeEqual(request.headers.get("authorization") ?? "", value))) return true;
  if (!config.password) return false;
  const cookieStore = await cookies();
  const cookie = cookieStore.get(COOKIE_NAME)?.value ?? "";
  const expected = createHash("sha256").update(config.password).digest("hex");
  return safeEqual(cookie, expected);
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  const result = await syncPricingCatalogs(databasePool, { sources: ["models.dev"] });
  const sync = result.results[0];
  const failed = sync?.status === "failed";
  const summary = {
    total: Number(sync?.modelCount ?? 0),
    updated: Number(sync?.updatedPriceCount ?? 0),
    skipped: Math.max(0, Number(sync?.matchedCount ?? 0) - Number(sync?.updatedPriceCount ?? 0)),
    failed: failed ? 1 : 0
  };
  return NextResponse.json({ summary, results: result.results, error: failed ? sync.error : undefined }, { status: failed ? 502 : 200 });
}
