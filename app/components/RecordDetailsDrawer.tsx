"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, AlertTriangle, CheckCircle2, ChevronRight, Clock3, Copy, Database, Download, Gauge, LoaderCircle, Network, X, Zap } from "lucide-react";
import type { CredentialErrorEvidence, ErrorCoverageStatus } from "@/lib/types";
import { calculateCacheRate, calculateOutputRate } from "@/lib/records/metrics";

type RecordDetails = {
  credentialErrors?: CredentialErrorEvidence;
  id: number;
  occurredAt: string;
  ingestedAt?: string | null;
  createdAt?: string | null;
  sourceInstanceId?: string | null;
  originSystem?: string | null;
  source?: string | null;
  sourceTransport?: string | null;
  sourceNativeId?: string | null;
  sourceEventKey?: string | null;
  requestId?: string | null;
  route?: string | null;
  credentialName?: string | null;
  provider?: string | null;
  apiGroupKey?: string | null;
  apiGroupLabel?: string | null;
  apiKeyMask?: string | null;
  endpoint?: string | null;
  authType?: string | null;
  clientIp?: string | null;
  xForwardedFor?: string | null;
  userAgent?: string | null;
  model?: string | null;
  modelAlias?: string | null;
  responseModel?: string | null;
  modelSubstituted?: boolean | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  responseServiceTier?: string | null;
  effectiveServiceTier?: string | null;
  billedServiceTier?: string | null;
  billedServiceTierSource?: string | null;
  resolvedServiceTier?: string | null;
  executorType?: string | null;
  accessProvider?: string | null;
  isNativeKey?: boolean | null;
  stream?: boolean | null;
  generate?: boolean | null;
  sessionId?: string | null;
  parentSessionId?: string | null;
  executionId?: string | null;
  traceId?: string | null;
  nodeKind?: string | null;
  isFork?: boolean | null;
  isCompaction?: boolean | null;
  resourceId?: string | null;
  resourceName?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  latencyMs?: number | null;
  ttftMs?: number | null;
  statusCode?: number | null;
  isError: boolean;
  failCode?: string | null;
  failBody?: string | null;
  responseHeaders?: unknown;
  tokenAccounting?: unknown;
  accountingStatus?: string | null;
  structuredUsage?: unknown;
  rawPayload?: unknown;
  cost?: number | null;
  costNanos?: number | null;
  costCurrency?: string | null;
  pricingStatus?: string | null;
  priceVersionId?: number | null;
  sourcePriceVersionId?: string | null;
  channelVersionId?: number | null;
  priceTierIndex?: number | null;
  pricingPolicyVersion?: number | null;
  costBreakdown?: unknown;
};

type Props = {
  eventId: number;
  occurredAt: string;
  onClose: () => void;
};

type DetailTab = "overview" | "usage" | "diagnostics" | "raw";

const errorCoverageLabels: Record<ErrorCoverageStatus, string> = {
  disabled: "采集已关闭", not_configured: "未配置错误采集", connecting: "正在连接",
  disconnected: "连接已断开", degraded: "采集异常", collecting: "窗口尚未结束 · 采集中",
  complete: "窗口覆盖完整", partial: "窗口覆盖不完整", historical_import: "历史快照导入",
  not_correlatable: "缺少关联凭据或时间", query_failed: "错误证据查询失败"
};

function CredentialErrors({ evidence }: { evidence?: CredentialErrorEvidence }) {
  const coverage = evidence?.coverage;
  const events = evidence?.events ?? [];
  const windowMs = evidence?.window_ms ?? 120000;
  const windowLabel = windowMs % 60000 === 0 ? `±${windowMs / 60000} 分钟` : `±${windowMs / 1000} 秒`;
  return (
    <Section title="凭据关联错误" description={`按同一 CPA 实例、同一凭据及请求时间前后 ${windowLabel} 关联，最多展示 20 条。仅供调查参考，不代表已证明的因果关系，也不是按 Request ID 精确匹配。`}>
      <p className="text-sm text-slate-300">{errorCoverageLabels[coverage?.status ?? "query_failed"]}</p>
      {!coverage?.complete ? (
        <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-amber-300" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          当前窗口尚未完整覆盖，可能包含断连、未采集区间或未结束的未来窗口。未查到记录不代表没有错误。
          {coverage?.status === "historical_import" ? "历史快照不证明连续采集。" : ""}
        </p>
      ) : null}
      {coverage?.reason === "source_error_table_unavailable" ? <p className="mt-2 text-xs text-amber-300">旧 OMC 数据库没有 error_events 表，历史错误不可用。</p> : null}
      {coverage?.gaps.length ? <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">未覆盖区间（{coverage.gaps.length}）</summary>
        <ul className="mt-1 space-y-1">{coverage.gaps.map((gap) => <li key={gap.from}>{timeText(gap.from)} → {timeText(gap.to)}</li>)}</ul>
      </details> : null}
      {!events.length ? <p className="mt-3 text-sm text-slate-500">{coverage?.complete ? "完整观测窗口内未记录到关联错误。" : "当前可用证据中未查到关联记录。"}</p> : (
        <div className="mt-3 space-y-3">{events.map((event) => (
          <article key={event.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <time>{timeText(event.occurred_at)}</time>
              <span className="font-mono text-indigo-300">Δ {event.time_delta_ms >= 0 ? "+" : ""}{event.time_delta_ms} ms</span>
              <span>HTTP {event.status_code ?? "—"} · {event.code || "—"}</span>
              <span>{event.origin_system === "oh_my_cpa" ? "OMC 历史导入" : "CPA 实时订阅"}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label={"Provider · " + (event.provider_match ? "匹配" : "未匹配")} value={event.provider} />
              <Field label={"模型 · " + (event.model_match ? "匹配" : "未匹配")} value={event.model} />
              <Field label="可重试" value={event.retryable} />
              <Field label="配额原因" value={event.quota_reason} />
              <Field label="凭据重试时间" value={timeText(event.next_retry_after)} />
              <Field label="凭据恢复时间" value={timeText(event.next_recover_at)} />
              <Field label="模型冷却" value={event.cooldown_model} />
              <Field label="模型恢复时间" value={timeText(event.model_next_recover_at)} />
            </div>
            {event.body ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950/70 p-2 text-xs leading-5 text-rose-200">{event.body}</pre> : null}
            <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">脱敏凭据 / 模型状态与退避</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ auth_status: event.auth_status, quota_exceeded: event.quota_exceeded,
                backoff_level: event.backoff_level, auth_quota_aggregate: event.auth_quota_aggregate, model_quota_inherited: event.model_quota_inherited,
                model_quota_exceeded: event.model_quota_exceeded, model_quota_reason: event.model_quota_reason,
                model_next_retry_after: event.model_next_retry_after, model_backoff_level: event.model_backoff_level }, null, 2)}</pre>
            </details>
          </article>
        ))}</div>
      )}
    </Section>
  );
}

type TokenSegment = {
  key: "cache_read" | "input" | "reasoning" | "output";
  label: string;
  value: number;
  color: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function valueText(value: unknown): string {
  if (!hasValue(value)) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value) ?? String(value);
  return String(value);
}

function numberText(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("zh-CN").format(number) : String(value);
}

function timeText(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}

function durationText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1000) return numberText(value) + " ms";
  if (value < 60_000) return (value / 1000).toFixed(2) + " s";
  const minutes = Math.floor(value / 60_000);
  const seconds = ((value % 60_000) / 1000).toFixed(1).padStart(4, "0");
  return minutes + "m " + seconds + "s";
}

function moneyText(value: number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未定价";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    }).format(value);
  } catch {
    return value.toFixed(8) + " " + currency;
  }
}

function rateText(value: unknown, currency: string): string {
  if (!hasValue(value)) return "—";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    }).format(amount) + " / 1M";
  } catch {
    return String(value) + " " + currency + " / 1M";
  }
}

function getTokenSegments(record: RecordDetails): { segments: TokenSegment[]; unplacedReasoning: number } {
  const input = Math.max(0, record.inputTokens || 0);
  const output = Math.max(0, record.outputTokens || 0);
  const reasoning = Math.max(0, record.reasoningTokens || 0);
  const cacheRead = Math.max(0, record.cacheReadTokens || record.cachedTokens || 0);
  const freshInput = cacheRead <= input ? input - cacheRead : input;
  let textOutput = output;
  let placedReasoning = 0;
  let unplacedReasoning = 0;

  if (reasoning > 0) {
    const prompt = cacheRead > input ? input + cacheRead : input;
    const total = Math.max(0, record.totalTokens || 0);
    if (total === prompt + output && reasoning <= output) {
      textOutput = output - reasoning;
      placedReasoning = reasoning;
    } else if (total === prompt + output + reasoning) {
      placedReasoning = reasoning;
    } else {
      unplacedReasoning = reasoning;
    }
  }

  const allSegments: TokenSegment[] = [
    { key: "cache_read", label: "缓存读取", value: cacheRead, color: "bg-cyan-400" },
    { key: "input", label: "普通输入", value: freshInput, color: "bg-indigo-400" },
    { key: "reasoning", label: "推理", value: placedReasoning, color: "bg-amber-400" },
    { key: "output", label: "普通输出", value: textOutput, color: "bg-emerald-400" }
  ];
  const segments = allSegments.filter((segment) => segment.value > 0);
  return { segments, unplacedReasoning };
}



function responseHeaderRows(value: unknown): Array<{ name: string; value: string }> {
  if (typeof value === "string") {
    try {
      return responseHeaderRows(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const row = asObject(item);
      if (!row) return [];
      const name = row.name ?? row.key;
      if (!hasValue(name)) return [];
      return [{ name: String(name), value: valueText(row.value) }];
    });
  }
  const object = asObject(value);
  if (!object) return [];
  return Object.entries(object).map(([name, headerValue]) => ({ name, value: valueText(headerValue) }));
}

function rawValue(record: RecordDetails, ...keys: string[]): unknown {
  const raw = asObject(record.rawPayload);
  if (!raw) return undefined;
  for (const key of keys) {
    if (hasValue(raw[key])) return raw[key];
  }
  return undefined;
}

function Section({ title, description, children, action }: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/55 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {description ? <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  if (!hasValue(value)) return null;
  return (
    <div className="min-w-0 rounded-lg bg-slate-900/70 px-3 py-2">
      <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className={"mt-1 break-all text-sm text-slate-200 " + (mono ? "font-mono text-xs" : "")}>{valueText(value)}</dd>
    </div>
  );
}

function Metric({ label, value, detail, icon: Icon }: {
  label: string;
  value: string;
  detail?: string;
  icon: typeof Clock3;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{label}</span>
      </div>
      <div className="mt-2 truncate text-lg font-semibold tabular-nums text-white">{value}</div>
      {detail ? <div className="mt-1 truncate text-[11px] text-slate-500">{detail}</div> : null}
    </div>
  );
}

function RouteNode({ label, value, detail, accent = "border-slate-700" }: {
  label: string;
  value: unknown;
  detail?: unknown;
  accent?: string;
}) {
  return (
    <div className={"min-w-0 rounded-xl border bg-slate-900/70 p-3 " + accent}>
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="mt-1 break-all text-sm font-semibold text-slate-100">{valueText(value)}</div>
      {hasValue(detail) ? <div className="mt-1 break-all text-xs text-slate-500">{valueText(detail)}</div> : null}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const empty = value === null || value === undefined || (typeof value === "object" && Object.keys(value as object).length === 0);
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-900/60">
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-slate-300">
        {title}
        <span className="ml-2 text-xs text-slate-500">{empty ? "无数据" : "展开查看"}</span>
      </summary>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all border-t border-slate-800 p-3 text-xs leading-5 text-slate-300">
        {empty ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
function humanizeKey(value: string): string {
  return value.split(/[_-]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function StructuredUsageView({ value }: { value: unknown }) {
  const object = asObject(value);
  if (!object) return <JsonBlock title="Structured Usage Payload" value={value} />;
  const entries = Object.entries(object);
  if (!entries.length) return <p className="text-sm text-slate-500">没有结构化用量字段。</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map(([key, item]) => {
        const nested = asObject(item);
        return nested ? (
          <div key={key} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <h4 className="mb-2 text-xs font-semibold text-slate-400">{humanizeKey(key)}</h4>
            <dl className="grid grid-cols-2 gap-2">
              {Object.entries(nested).map(([nestedKey, nestedValue]) => (
                <Field key={nestedKey} label={humanizeKey(nestedKey)} value={nestedValue} />
              ))}
            </dl>
          </div>
        ) : <Field key={key} label={humanizeKey(key)} value={item} />;
      })}
    </div>
  );
}

function costBucketName(value: unknown): string {
  const names: Record<string, string> = {
    input: "普通输入",
    cache_read: "缓存读取",
    output: "输出",
    cache_write: "缓存写入"
  };
  const key = String(value ?? "");
  return names[key] ?? humanizeKey(key);
}

function TabButton({ id, label, active, onClick }: {
  id: DetailTab;
  label: string;
  active: boolean;
  onClick: (tab: DetailTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={"record-tab-" + id}
      aria-selected={active}
      aria-controls="record-detail-panel"
      onClick={() => onClick(id)}
      className={"relative -mb-px border-b-2 px-3 py-3 text-sm font-medium transition-colors " +
        (active ? "border-indigo-400 text-white" : "border-transparent text-slate-500 hover:text-slate-200")}
    >
      {label}
    </button>
  );
}

export default function RecordDetailsDrawer({ eventId, occurredAt, onClose }: Props) {
  const [record, setRecord] = useState<RecordDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [requestLogBusy, setRequestLogBusy] = useState(false);
  const [requestLogMessage, setRequestLogMessage] = useState<string | null>(null);
  const [requestLogError, setRequestLogError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRecord(null);
    setActiveTab("overview");
    setRequestLogMessage(null);
    const params = new URLSearchParams({ eventId: String(eventId), occurredAt });
    fetch("/api/records/detail?" + params.toString(), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || response.statusText);
        setRecord(payload.item as RecordDetails);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "加载请求详情失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [eventId, occurredAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const costLabel = useMemo(() => {
    if (!record || record.cost === null || record.cost === undefined) return "未定价";
    return moneyText(record.cost, record.costCurrency ?? "USD");
  }, [record]);
  const rate = useMemo(() => record ? calculateOutputRate(record) : null, [record]);
  const segments = useMemo(() => record ? getTokenSegments(record) : { segments: [], unplacedReasoning: 0 }, [record]);
  const segmentTotal = segments.segments.reduce((sum, item) => sum + item.value, 0);
  const cacheHitRate = record ? calculateCacheRate(record) : null;
  const headers = useMemo(() => responseHeaderRows(record?.responseHeaders), [record?.responseHeaders]);
  const accountingStatus = record?.accountingStatus ?? (asObject(record?.tokenAccounting)?.status as string | undefined) ?? (record?.tokenAccounting ? "unknown" : "legacy");
  const accountingComplete = ["complete", "valid", "canonical", "verified", "reconciled", "exact"].includes(String(accountingStatus).toLowerCase());
  const accountingLegacy = String(accountingStatus).toLowerCase() === "legacy";

  async function copyText(value: string, successMessage: (message: string) => void) {
    try {
      await navigator.clipboard.writeText(value);
      successMessage("已复制");
    } catch {
      successMessage("复制失败，请检查浏览器剪贴板权限");
    }
  }

  async function copyRequestId() {
    if (!record?.requestId) return;
    setCopied(false);
    await copyText(record.requestId, setCopiedMessage);
  }

  function setCopiedMessage(message: string) {
    setCopied(message === "已复制");
    if (message === "已复制") window.setTimeout(() => setCopied(false), 1500);
  }

  async function downloadRequestLog() {
    if (!record?.requestId || requestLogBusy) return;
    setRequestLogBusy(true);
    setRequestLogMessage(null);
    setRequestLogError(false);
    try {
      const response = await fetch("/api/records/request-log?eventId=" + encodeURIComponent(String(eventId)), { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "下载请求日志失败");
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "request-" + eventId + ".log";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      setRequestLogMessage("已开始下载 CPA 请求日志");
    } catch (cause) {
      setRequestLogError(true);
      setRequestLogMessage(cause instanceof Error ? cause.message : "下载请求日志失败");
    } finally {
      setRequestLogBusy(false);
    }
  }

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: "overview", label: "概览" },
    { id: "usage", label: "用量与计价" },
    { id: "diagnostics", label: "诊断" },
    { id: "raw", label: "原始字段" }
  ];

  const rawPayload = asObject(record?.rawPayload);
  const costBreakdown = asObject(record?.costBreakdown);
  const costBuckets = Array.isArray(costBreakdown?.buckets)
    ? costBreakdown.buckets.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];

  return (
    <div
      className="fixed inset-0 z-[80] flex justify-end bg-black/65 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="请求详情"
        className="flex h-full w-full max-w-6xl flex-col border-l border-slate-700 bg-slate-950 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-800 bg-slate-950/95 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={"inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold " +
                (record?.isError ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300")}>
                {record ? (record.isError ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />) : null}
                {record ? (record.isError ? "请求失败" : "请求成功") : "请求详情"}
              </span>
              {record?.statusCode ? <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">HTTP {record.statusCode}</span> : null}
              <span className="text-xs text-slate-500">事件 #{eventId}</span>
            </div>
            <h2 className="mt-2 truncate text-lg font-semibold text-white">{record?.modelAlias || record?.model || "正在加载请求详情"}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="shrink-0">{timeText(record?.occurredAt ?? occurredAt)}</span>
              <span>·</span>
              <span className="truncate font-mono">{record?.requestId ?? "Request ID 暂不可用"}</span>
              {record?.requestId ? (
                <button onClick={copyRequestId} className="shrink-0 text-indigo-300 hover:text-indigo-200" title="复制 Request ID" aria-label="复制 Request ID">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {copied ? <span className="text-emerald-400">已复制</span> : null}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="关闭请求详情">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="shrink-0 border-b border-slate-800 bg-slate-950/90 px-5 pt-4">
          {record ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <Metric label="总耗时" value={durationText(record.latencyMs)} detail={hasValue(record.ttftMs) ? "TTFT " + durationText(record.ttftMs) : "首 Token 延迟未记录"} icon={Clock3} />
              <Metric label="输出速率" value={rate === null ? "—" : rate.toFixed(2) + " t/s"} detail="按输出 Tokens / 总耗时计算" icon={Gauge} />
              <Metric label="总 Tokens" value={numberText(record.totalTokens)} detail={"输入 " + numberText(record.inputTokens) + " · 输出 " + numberText(record.outputTokens)} icon={Zap} />
              <Metric label="费用" value={costLabel} detail={record.pricingStatus ?? "定价状态未知"} icon={Database} />
              <Metric label="Provider" value={valueText(record.provider)} detail={record.executorType ?? "执行器未记录"} icon={Network} />
            </div>
          ) : (
            <div className="h-20 animate-pulse rounded-xl bg-slate-900/70" />
          )}
          <nav className="-mb-px mt-4 flex gap-1 overflow-x-auto" role="tablist" aria-label="请求详情分类">
            {tabs.map((tab) => (
              <TabButton key={tab.id} id={tab.id} label={tab.label} active={activeTab === tab.id} onClick={setActiveTab} />
            ))}
          </nav>
        </div>

        <main
          id="record-detail-panel"
          role="tabpanel"
          aria-labelledby={"record-tab-" + activeTab}
          className="min-h-0 flex-1 overflow-y-auto p-5"
        >
          {loading ? (
            <div className="flex min-h-64 items-center justify-center gap-3 text-sm text-slate-400">
              <LoaderCircle className="h-5 w-5 animate-spin" /> 正在读取完整事件记录…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-200">{error}</div>
          ) : record ? (
            <div className="space-y-4">
              {activeTab === "overview" ? (
                <>
                  {record.isError ? (
                    <section className="rounded-xl border border-rose-500/30 bg-rose-950/25 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
                          <AlertTriangle className="h-4 w-4" />
                          {record.failCode || (record.statusCode ? "HTTP " + record.statusCode : "请求失败")}
                        </div>
                        <button type="button" onClick={() => setActiveTab("diagnostics")} className="text-xs font-medium text-rose-300 hover:text-rose-200">
                          查看诊断详情 <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
                        </button>
                      </div>
                      {record.failBody ? <pre className="mt-3 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/20 p-3 text-xs leading-5 text-rose-100">{record.failBody}</pre> : <p className="mt-2 text-xs text-rose-300/80">CPA 未提供该请求的错误正文。</p>}
                    </section>
                  ) : null}

                  <Section title="调用链路" description="从请求调用方到 CPA Provider 与实际使用的凭证。">
                    <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
                      <RouteNode label="调用方" value={record.apiGroupLabel || record.apiKeyMask || record.route} detail={record.credentialName || record.authType} accent="border-indigo-500/30" />
                      <ArrowRight className="hidden h-4 w-4 text-slate-600 md:block" />
                      <RouteNode label="Provider" value={record.provider} detail={record.accessProvider || record.executorType} accent="border-sky-500/30" />
                      <ArrowRight className="hidden h-4 w-4 text-slate-600 md:block" />
                      <RouteNode label="使用凭证" value={record.credentialName || record.apiKeyMask || record.route} detail={record.isNativeKey === null || record.isNativeKey === undefined ? record.authType : (record.isNativeKey ? "原生 API Key" : "非原生 Key")} accent="border-emerald-500/30" />
                    </div>
                  </Section>

                  <Section title="模型路由" description="区分调用方选择的模型、CPA 请求模型，以及上游实际响应的模型。">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center">
                      <RouteNode label="调用模型" value={record.modelAlias || record.model} detail={record.modelAlias && record.modelAlias !== record.model ? "模型别名" : "请求模型"} accent="border-indigo-500/30" />
                      {record.modelAlias && record.modelAlias !== record.model ? <ChevronRight className="mx-auto h-4 w-4 rotate-90 text-slate-600 md:rotate-0" /> : null}
                      {record.modelAlias && record.modelAlias !== record.model ? <RouteNode label="CPA 请求模型" value={record.model} accent="border-slate-700" /> : null}
                      {record.responseModel ? <ChevronRight className="mx-auto h-4 w-4 rotate-90 text-slate-600 md:rotate-0" /> : null}
                      {record.responseModel ? (
                        <RouteNode
                          label="响应模型"
                          value={record.responseModel}
                          detail={record.modelSubstituted ? "检测到模型替换" : "上游响应模型"}
                          accent={record.modelSubstituted ? "border-amber-500/40" : "border-emerald-500/30"}
                        />
                      ) : null}
                    </div>
                  </Section>

                  <Section title="请求性能" description="总耗时包含首 Token 等待；若 CPA 提供 TTFT，可进一步拆分等待和生成阶段。">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">总耗时</div>
                        <div className="mt-1 text-lg font-semibold text-white">{durationText(record.latencyMs)}</div>
                      </div>
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">首 Token 延迟</div>
                        <div className="mt-1 text-lg font-semibold text-white">{durationText(record.ttftMs)}</div>
                      </div>
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">首 Token 后生成</div>
                        <div className="mt-1 text-lg font-semibold text-white">
                          {record.latencyMs != null && record.ttftMs != null && record.ttftMs > 0 && record.ttftMs < record.latencyMs
                            ? durationText(record.latencyMs - record.ttftMs)
                            : "未拆分"}
                        </div>
                      </div>
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">输出速率</div>
                        <div className="mt-1 text-lg font-semibold text-white">{rate === null ? "—" : rate.toFixed(2) + " t/s"}</div>
                      </div>
                    </div>
                    {record.latencyMs != null && record.latencyMs > 0 ? (
                      <div className="mt-4">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
                          <span>首 Token 等待 / 后续生成</span>
                          <span>{record.ttftMs != null && record.ttftMs > 0 && record.ttftMs < record.latencyMs ? "TTFT 已记录" : "无 TTFT 拆分数据"}</span>
                        </div>
                        <div className="flex h-2 overflow-hidden rounded-full bg-slate-800">
                          {record.ttftMs != null && record.ttftMs > 0 && record.ttftMs < record.latencyMs ? (
                            <>
                              <span className="bg-indigo-400" style={{ width: (record.ttftMs / record.latencyMs * 100) + "%" }} />
                              <span className="flex-1 bg-emerald-400" />
                            </>
                          ) : <span className="w-full bg-emerald-400" />}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-400">
                          <span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-indigo-400" />首 Token 等待</span>
                          <span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-400" />后续生成 / 总耗时</span>
                        </div>
                      </div>
                    ) : null}
                  </Section>

                  <Section title="Token 构成" description="缓存读取按 CPA 用量口径展示；Reasoning 仅在总量关系能够确认时从输出中拆出，避免重复计数。">
                    {segmentTotal > 0 ? (
                      <>
                        <div className="flex h-3 overflow-hidden rounded-full bg-slate-800" role="img" aria-label="Token 构成比例">
                          {segments.segments.map((segment) => (
                            <span key={segment.key} className={segment.color} style={{ width: (segment.value / segmentTotal * 100) + "%" }} />
                          ))}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {segments.segments.map((segment) => (
                            <div key={segment.key} className="rounded-lg bg-slate-900/70 px-3 py-2">
                              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                                <i className={"h-2 w-2 rounded-full " + segment.color} />
                                {segment.label}
                              </div>
                              <div className="mt-1 text-sm font-semibold tabular-nums text-slate-100">{numberText(segment.value)}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : <p className="text-sm text-slate-500">该请求没有可展示的 Token 计数。</p>}
                    <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-800 pt-3 text-xs text-slate-400">
                      <span>缓存命中率：{cacheHitRate === null ? "—" : cacheHitRate.toFixed(1) + "%"}</span>
                      <span>缓存写入：{numberText(record.cacheCreationTokens)} Tokens</span>
                      {segments.unplacedReasoning > 0 ? <span className="text-amber-300">另有 {numberText(segments.unplacedReasoning)} Reasoning Tokens，当前总量关系不足以确认其是否已计入输出。</span> : null}
                    </div>
                  </Section>

                  <Section title="请求参数">
                    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <Field label="Reasoning Effort" value={record.reasoningEffort} />
                      <Field label="请求 Service Tier" value={record.serviceTier} />
                      <Field label="响应 Service Tier" value={record.responseServiceTier} />
                      <Field label="有效 Service Tier" value={record.effectiveServiceTier} />
                      <Field label="计费 Service Tier" value={record.billedServiceTier || record.resolvedServiceTier} />
                      <Field label="计费 Tier 来源" value={record.billedServiceTierSource} />
                      <Field label="传输模式" value={record.sourceTransport} />
                      <Field label="Executor" value={record.executorType} />
                      <Field label="Stream" value={record.stream} />
                      <Field label="Generate" value={record.generate} />
                    </dl>
                  </Section>
                </>
              ) : null}

              {activeTab === "usage" ? (
                <>
                  <div className={"rounded-xl border px-4 py-3 text-sm " +
                    (accountingComplete ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-200" : accountingLegacy ? "border-slate-700 bg-slate-900/60 text-slate-300" : "border-amber-500/25 bg-amber-500/5 text-amber-200")}>
                    <div className="font-semibold">Token Accounting · {valueText(accountingStatus)}</div>
                    <p className="mt-1 text-xs leading-5 opacity-80">
                      {accountingComplete
                        ? "CPA 已提供可验证的 Token Accounting 证据；Reasoning 与缓存桶按其归属口径展示。"
                        : accountingLegacy
                          ? "该记录没有完整 Token Accounting 结构，按已保存的传统计数展示。"
                          : "Token Accounting 尚未确认完整性。费用和速率指标应结合原始字段谨慎解读。"}
                    </p>
                  </div>

                  <Section title="Token 用量明细" description="以下为 CPA 保存的原始计数。Reasoning 通常是 Output 的子集，不应直接与 Output 相加。">
                    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                      <Field label="Input Tokens" value={numberText(record.inputTokens)} />
                      <Field label="Output Tokens" value={numberText(record.outputTokens)} />
                      <Field label="Reasoning Tokens" value={numberText(record.reasoningTokens)} />
                      <Field label="Cached Tokens" value={numberText(record.cachedTokens)} />
                      <Field label="Cache Read Tokens" value={numberText(record.cacheReadTokens)} />
                      <Field label="Cache Creation / Write" value={numberText(record.cacheCreationTokens)} />
                      <Field label="Total Tokens" value={numberText(record.totalTokens)} />
                    </dl>
                  </Section>

                  <Section title="费用与计价证据" description="成本来自请求发生时锁定的价格版本与渠道倍率版本，不随当前价格配置变化。">
                    <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">本次费用</div>
                        <div className="mt-1 break-all text-lg font-semibold text-white">{costLabel}</div>
                      </div>
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">Pricing Status</div>
                        <div className="mt-1 text-sm font-semibold text-slate-100">{valueText(record.pricingStatus)}</div>
                      </div>
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">Price Version</div>
                        <div className="mt-1 text-sm font-semibold text-slate-100">{valueText(record.priceVersionId)}</div>
                      </div>
                      <div className="rounded-lg bg-slate-900/70 p-3">
                        <div className="text-xs text-slate-500">Channel Version</div>
                        <div className="mt-1 text-sm font-semibold text-slate-100">{valueText(record.channelVersionId)}</div>
                      </div>
                    </div>
                    {costBuckets.length > 0 ? (
                      <div className="overflow-x-auto rounded-lg border border-slate-800">
                        <table className="w-full min-w-[520px] text-left text-sm">
                          <thead className="bg-slate-900 text-xs text-slate-500">
                            <tr>
                              <th className="px-3 py-2.5">计价桶</th>
                              <th className="px-3 py-2.5 text-right">Tokens</th>
                              <th className="px-3 py-2.5 text-right">费率 / 1M</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800">
                            {costBuckets.map((bucket, index) => (
                              <tr key={String(bucket.kind ?? index)}>
                                <td className="px-3 py-2.5 text-slate-300">{costBucketName(bucket.kind)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{numberText(String(bucket.tokens ?? "0"))}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-200">{rateText(bucket.rate_per_1m, record.costCurrency ?? "USD")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="rounded-lg bg-slate-900/70 p-3 text-sm text-slate-500">
                        {hasValue(costBreakdown?.reason) ? "未形成计价结果：" + String(costBreakdown?.reason) : "没有保存可展开的成本计算明细。"}
                      </p>
                    )}
                    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <Field label="Model Multiplier" value={costBreakdown?.model_multiplier} />
                      <Field label="Channel Multiplier" value={costBreakdown?.channel_multiplier} />
                      <Field label="Selected Tier Index" value={costBreakdown?.selected_tier_index ?? record.priceTierIndex} />
                      <Field label="Resolved Service Tier" value={record.resolvedServiceTier} />
                      <Field label="Pricing Policy Version" value={record.pricingPolicyVersion} />
                      <Field label="Source Price Version ID" value={record.sourcePriceVersionId} mono />
                      <Field label="Cost Nanos" value={numberText(record.costNanos)} mono />
                      <Field label="币种" value={record.costCurrency} />
                    </dl>
                    {hasValue(costBreakdown?.selected_tier) ? <div className="mt-3"><JsonBlock title="命中的 Tier 规则" value={costBreakdown?.selected_tier} /></div> : null}
                  </Section>

                  <Section title="Structured Usage" description="CPA 返回的多模态、缓存 TTL、输入输出细分及其他结构化用量信息。">
                    <StructuredUsageView value={record.structuredUsage} />
                  </Section>
                  <Section title="Token Accounting 原始证据">
                    <JsonBlock title="Token Accounting Payload" value={record.tokenAccounting} />
                  </Section>
                </>
              ) : null}

              {activeTab === "diagnostics" ? (
                <>
                  <CredentialErrors evidence={record.credentialErrors} />
                  {record.isError ? (
                    <Section title="错误与失败原因" description="以下内容来自当前请求本身，不与其他请求的错误混合。">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <Field label="结果" value="失败" />
                        <Field label="HTTP Status" value={record.statusCode} />
                        <Field label="Fail Code" value={record.failCode} mono />
                      </div>
                      {record.failBody ? (
                        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-rose-500/20 bg-rose-950/20 p-3 text-xs leading-5 text-rose-200">{record.failBody}</pre>
                      ) : <p className="mt-3 text-xs text-slate-500">CPA 未保存错误正文。</p>}
                    </Section>
                  ) : (
                    <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
                      <CheckCircle2 className="h-4 w-4" /> 当前请求没有被标记为失败。
                    </div>
                  )}

                  <Section
                    title="响应头"
                    description="CPA 保存的响应头字段；内容经过脱敏后展示。"
                    action={headers.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => void copyText(headers.map((header) => header.name + ": " + header.value).join("\n"), setCopiedMessage)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-indigo-300 hover:bg-slate-800"
                      >
                        <Copy className="h-3.5 w-3.5" /> 复制响应头
                      </button>
                    ) : null}
                  >
                    {headers.length > 0 ? (
                      <div className="overflow-x-auto rounded-lg border border-slate-800">
                        <table className="w-full min-w-[420px] text-left text-xs">
                          <tbody className="divide-y divide-slate-800">
                            {headers.map((header, index) => (
                              <tr key={header.name + "-" + index}>
                                <th className="w-1/3 break-all bg-slate-900/70 px-3 py-2.5 font-mono font-medium text-slate-400">{header.name}</th>
                                <td className="break-all px-3 py-2.5 font-mono text-slate-200">{header.value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : <p className="text-sm text-slate-500">该请求没有保存响应头。</p>}
                  </Section>

                  <Section title="网络与客户端" description="用于排查请求来源、反向代理链路和客户端环境。">
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Field label="Client IP" value={record.clientIp} mono />
                      <Field label="X-Forwarded-For" value={record.xForwardedFor} mono />
                      <Field label="User Agent" value={record.userAgent} />
                    </dl>
                  </Section>

                  <Section title="CPA 原始请求日志" description="按 Request ID 向 CPA 管理接口获取独立请求日志；该文件是否存在取决于 CPA 的请求日志配置。">
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void downloadRequestLog()}
                        disabled={!record.requestId || requestLogBusy}
                        className="inline-flex items-center gap-2 rounded-lg border border-indigo-500/40 bg-indigo-600/15 px-3 py-2 text-sm font-medium text-indigo-200 transition hover:bg-indigo-600/25 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {requestLogBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        {requestLogBusy ? "正在下载…" : "下载 CPA 请求日志"}
                      </button>
                      <span className="text-xs text-slate-500">Request ID：{record.requestId || "不可用"}</span>
                    </div>
                    {requestLogMessage ? (
                      <p className={"mt-3 text-xs " + (requestLogError ? "text-rose-300" : "text-emerald-300")}>{requestLogMessage}</p>
                    ) : null}
                  </Section>
                </>
              ) : null}

              {activeTab === "raw" ? (
                <>
                  <Section title="路由与身份字段" description="完整保留 CPA 事件中的调用身份与来源信息。">
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      <Field label="Provider" value={record.provider} />
                      <Field label="Access Provider" value={record.accessProvider} />
                      <Field label="Credential" value={record.credentialName} />
                      <Field label="API Group" value={record.apiGroupLabel} />
                      <Field label="API Group Key" value={record.apiGroupKey} mono />
                      <Field label="API Key Mask" value={record.apiKeyMask || record.route} mono />
                      <Field label="Auth Type" value={record.authType} />
                      <Field label="Native Key" value={record.isNativeKey} />
                      <Field label="Auth Index" value={rawValue(record, "auth_index", "authIndex")} mono />
                      <Field label="Resource ID" value={record.resourceId || rawValue(record, "resource_id", "resourceId")} mono />
                      <Field label="Resource Name" value={record.resourceName || rawValue(record, "resource_name", "resourceName")} />
                      <Field label="Endpoint" value={record.endpoint} mono />
                      <Field label="Executor" value={record.executorType} />
                      <Field label="Source" value={record.source || record.originSystem} />
                      <Field label="Collector Transport" value={record.sourceTransport} />
                      <Field label="Collector Instance" value={record.sourceInstanceId} mono />
                      <Field label="CPA Native Event ID" value={record.sourceNativeId} mono />
                      <Field label="Source Event Key" value={record.sourceEventKey} mono />
                    </dl>
                  </Section>

                  <Section title="模型与请求参数">
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      <Field label="Model Alias" value={record.modelAlias} />
                      <Field label="Request Model" value={record.model} />
                      <Field label="Response Model" value={record.responseModel} />
                      <Field label="Model Substituted" value={record.modelSubstituted} />
                      <Field label="Reasoning Effort" value={record.reasoningEffort} />
                      <Field label="Request Service Tier" value={record.serviceTier} />
                      <Field label="Response Service Tier" value={record.responseServiceTier} />
                      <Field label="Effective Service Tier" value={record.effectiveServiceTier} />
                      <Field label="Billed Service Tier" value={record.billedServiceTier} />
                      <Field label="Billed Tier Source" value={record.billedServiceTierSource} />
                      <Field label="Stream" value={record.stream} />
                      <Field label="Generate" value={record.generate} />
                    </dl>
                  </Section>

                  <Section title="执行上下文">
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      <Field label="Session ID" value={record.sessionId} mono />
                      <Field label="Parent Session ID" value={record.parentSessionId} mono />
                      <Field label="Execution ID" value={record.executionId} mono />
                      <Field label="Trace ID" value={record.traceId} mono />
                      <Field label="Node Kind" value={record.nodeKind} />
                      <Field label="Fork" value={record.isFork} />
                      <Field label="Compaction" value={record.isCompaction} />
                    </dl>
                  </Section>

                  <Section title="事件时间与内部标识">
                    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      <Field label="Event ID" value={record.id} mono />
                      <Field label="Request ID" value={record.requestId} mono />
                      <Field label="发生时间" value={timeText(record.occurredAt)} />
                      <Field label="入库时间" value={timeText(record.ingestedAt)} />
                      <Field label="创建时间" value={timeText(record.createdAt)} />
                      <Field label="Origin System" value={record.originSystem} />
                    </dl>
                  </Section>

                  <Section title="原始事件 Payload" description="仅展示已进入 Monitor 持久化层的脱敏 Payload。">
                    <JsonBlock title="Raw Payload（已脱敏）" value={rawPayload} />
                  </Section>
                </>
              ) : null}
            </div>
          ) : null}
        </main>
      </aside>
    </div>
  );
}
