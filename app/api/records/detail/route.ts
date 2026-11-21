import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getUsageRecordDetails } from "@/lib/queries/records";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  const { searchParams } = new URL(request.url);
  const eventId = Number(searchParams.get("eventId"));
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    return NextResponse.json({ error: "A valid eventId is required" }, { status: 400 });
  }

  try {
    const item = await getUsageRecordDetails(eventId);
    if (!item) return NextResponse.json({ error: "Record not found" }, { status: 404 });
    return NextResponse.json({ item }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("/api/records/detail failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
