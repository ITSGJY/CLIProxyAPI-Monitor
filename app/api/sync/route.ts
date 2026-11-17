import { NextResponse } from "next/server";
import * as nextHeaders from "next/headers";
import * as DrizzleOrm from "drizzle-orm";
import { assertEnv, config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { authFileMappings, usageCollectorCommands, usageCollectorInstances, usageCollectorState } from "@/lib/db/schema";
import { toAuthFileMappings } from "@/lib/auth-files";

const { and, asc, eq, gt, sql } = DrizzleOrm as any;
const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";
const AUTH_FILES_TIMEOUT_MS = 15_000;
const AUTH_FILES_INSERT_CHUNK_SIZE = 500;

export const runtime = "nodejs";

function missingPassword() {
  return NextResponse.json({ error: "PASSWORD or CRON_SECRET is missing" }, { status: 501 });
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(request: Request) {
  const allowed = [config.password, config.cronSecret]
    .filter(Boolean)
    .map((value) => "Bearer " + value);

  if (allowed.length > 0) {
    const authorization = request.headers.get("authorization") || "";
    if (allowed.includes(authorization)) return true;
  }

  if (PASSWORD) {
    const cookieStore = (await (nextHeaders as any).cookies());
    const authCookie = cookieStore.get(COOKIE_NAME);
    if (authCookie) {
      const expectedToken = await hashPassword(PASSWORD);
      if (authCookie.value === expectedToken) return true;
    }
  }

  return false;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function syncAuthFileMappings(pulledAt: Date) {
  if (!config.cliproxy.apiKey || !config.cliproxy.baseUrl) return 0;

  const authFilesUrl = `${config.cliproxy.baseUrl.replace(/\/$/, "")}/auth-files`;
  const response = await fetchWithTimeout(authFilesUrl, {
    headers: {
      Authorization: `Bearer ${config.cliproxy.apiKey}`,
      Accept: "application/json"
    },
    cache: "no-store",
    redirect: "error"
  }, AUTH_FILES_TIMEOUT_MS);

  if (!response.ok) throw new Error(`auth-files returned HTTP ${response.status}`);

  const rows = toAuthFileMappings(await response.json(), pulledAt);
  for (const chunk of chunkArray(rows, AUTH_FILES_INSERT_CHUNK_SIZE)) {
    await db
      .insert(authFileMappings)
      .values(chunk)
      .onConflictDoUpdate({
        target: authFileMappings.authId,
        set: {
          name: sql`coalesce(nullif(excluded.name, ''), ${authFileMappings.name})`,
          label: sql`coalesce(nullif(excluded.label, ''), ${authFileMappings.label})`,
          provider: sql`coalesce(nullif(excluded.provider, ''), ${authFileMappings.provider})`,
          source: sql`coalesce(nullif(excluded.source, ''), ${authFileMappings.source})`,
          email: sql`coalesce(nullif(excluded.email, ''), ${authFileMappings.email})`,
          updatedAt: sql`coalesce(excluded.updated_at, ${authFileMappings.updatedAt})`,
          syncedAt: pulledAt
        }
      });
  }
  return rows.length;
}

async function enqueuePull(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  if (!config.password && !config.cronSecret && !PASSWORD) return missingPassword();
  if (!(await isAuthorized(request))) return unauthorized();

  let authFilesSynced = 0;
  let authFilesWarning: string | undefined;
  try {
    authFilesSynced = await syncAuthFileMappings(new Date());
  } catch (error) {
    authFilesWarning = error instanceof Error && error.name === "AbortError"
      ? "auth-files sync timed out"
      : "auth-files sync failed";
    console.warn("[sync] auth-files refresh failed:", authFilesWarning);
  }

  try {
    const [instance] = await db
      .select({ instanceId: usageCollectorInstances.instanceId })
      .from(usageCollectorInstances)
      .innerJoin(usageCollectorState, eq(usageCollectorState.instanceId, usageCollectorInstances.instanceId))
      .where(and(
        eq(usageCollectorInstances.enabled, true),
        eq(usageCollectorState.state, "receiving"),
        gt(usageCollectorState.updatedAt, new Date(Date.now() - 30_000))
      ))
      .orderBy(asc(usageCollectorInstances.instanceId))
      .limit(1);

    if (!instance) {
      return NextResponse.json(
        {
          error: "No healthy CPA Collector heartbeat was found. Start the isolated Collector and retry.",
          authFilesSynced,
          ...(authFilesWarning ? { authFilesWarning } : {})
        },
        { status: 503 }
      );
    }

    const [command] = await db
      .insert(usageCollectorCommands)
      .values({
        instanceId: instance.instanceId,
        command: "pull_now",
        status: "pending",
        requestedBy: request.method === "GET" ? "scheduled" : "dashboard"
      })
      .returning({ id: usageCollectorCommands.id });

    return NextResponse.json(
      {
        status: "queued",
        commandId: Number(command.id),
        inserted: 0,
        attempted: 0,
        authFilesSynced,
        message: "CPA usage pull request queued for the Collector.",
        ...(authFilesWarning ? { authFilesWarning } : {})
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("Failed to enqueue CPA usage pull:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Failed to enqueue Collector command" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return enqueuePull(request);
}

export async function GET(request: Request) {
  return enqueuePull(request);
}
