import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";

export const runtime = "nodejs";

const multiplierSchema = z.union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100, "multiplier must be > 0 and <= 100");

const schema = z.object({
  channel: z.string().trim().min(1).max(256),
  multiplier: multiplierSchema,
  note: z.string().max(512).default("")
});

export async function GET() {
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  try {
    const [channels, versions] = await Promise.all([
      databasePool.query("SELECT * FROM pricing_channels ORDER BY channel"),
      databasePool.query("SELECT * FROM pricing_channel_versions ORDER BY effective_from DESC, id DESC LIMIT 100")
    ]);
    return NextResponse.json({ channels: channels.rows, versions: versions.rows });
  } catch (error) {
    console.error("/api/pricing/channels GET failed:", error);
    return NextResponse.json({ error: "Failed to load channel prices" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  try {
    const data = parsed.data;
    const result = await databasePool.query(
      `INSERT INTO pricing_channels (channel, multiplier, note, updated_at, created_by)
       VALUES ($1, $2, $3, now(), 'dashboard')
       ON CONFLICT (channel) DO UPDATE SET multiplier = EXCLUDED.multiplier, note = EXCLUDED.note, updated_at = now()
       RETURNING *`,
      [data.channel, data.multiplier, data.note]
    );
    return NextResponse.json({ ok: true, channel: result.rows[0] });
  } catch (error) {
    console.error("/api/pricing/channels POST failed:", error);
    return NextResponse.json({ error: "Failed to save channel multiplier" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const channel = String(body?.channel ?? "").trim();
  if (!channel) return NextResponse.json({ error: "channel is required" }, { status: 400 });
  try {
    const result = await databasePool.query("DELETE FROM pricing_channels WHERE channel = $1 RETURNING channel", [channel]);
    if (!result.rowCount) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/pricing/channels DELETE failed:", error);
    return NextResponse.json({ error: "Failed to remove channel multiplier" }, { status: 500 });
  }
}
