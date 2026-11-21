import { NextResponse } from "next/server";
import { assertCpaEnv, config } from "@/lib/config";
import { getUsageRecordDetails } from "@/lib/queries/records";

export const runtime = "nodejs";

const MAX_REQUEST_LOG_BYTES = 16 * 1024 * 1024;

export async function GET(request: Request) {
  try {
    assertCpaEnv();
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

    const requestId = typeof item.requestId === "string" ? item.requestId.trim() : "";
    if (!requestId || requestId.includes("..") || requestId.includes("/") || requestId.includes(String.fromCharCode(92))) {
      return NextResponse.json({ error: "该记录没有可用于查询 CPA 请求日志的 Request ID" }, { status: 409 });
    }

    const managementBase = config.cliproxy.baseUrl.endsWith("/")
      ? config.cliproxy.baseUrl.slice(0, -1)
      : config.cliproxy.baseUrl;
    const endpoint = `${managementBase}/observability/logs/requests/${encodeURIComponent(requestId)}`;
    const upstream = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${config.cliproxy.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });

    if (upstream.status === 404) {
      return NextResponse.json({ error: "CPA 未保存该请求的独立日志文件；请确认 CPA 请求日志功能已启用" }, { status: 404 });
    }
    if (!upstream.ok) {
      console.warn("/api/records/request-log upstream failed:", upstream.status);
      return NextResponse.json({ error: `CPA 请求日志接口返回 HTTP ${upstream.status}` }, { status: 502 });
    }

    const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_REQUEST_LOG_BYTES) {
      return NextResponse.json({ error: "请求日志超过 16 MB 下载上限" }, { status: 413 });
    }
    const payload = await upstream.arrayBuffer();
    if (payload.byteLength > MAX_REQUEST_LOG_BYTES) {
      return NextResponse.json({ error: "请求日志超过 16 MB 下载上限" }, { status: 413 });
    }

    const safeId = requestId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || String(eventId);
    return new NextResponse(payload, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="request-${safeId}.log"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    console.error("/api/records/request-log failed:", error);
    return NextResponse.json(
      { error: isTimeout ? "下载 CPA 请求日志超时，请稍后重试" : "无法从 CPA 下载请求日志" },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
