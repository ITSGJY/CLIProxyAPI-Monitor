"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy, LoaderCircle, X } from "lucide-react";
type RecordDetails = {
  id: number;
  occurredAt: string;
  ingestedAt?: string | null;
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
  structuredUsage?: unknown;
  rawPayload?: unknown;
  cost?: number | null;
  costNanos?: number | null;
  costCurrency?: string | null;
  pricingStatus?: string | null;
  priceVersionId?: number | null;
  sourcePriceVersionId?: string | null;
};

type Props = {
  eventId: number;
  occurredAt: string;
  onClose: () => void;
};

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function timeText(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/55 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {description ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-900/70 px-3 py-2">
      <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className={`mt-1 break-all text-sm text-slate-200 ${mono ? "font-mono text-xs" : ""}`}>{valueText(value)}</dd>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const empty = value === null || value === undefined;
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-900/60">
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-slate-300">
        {title}
        <span className="ml-2 text-xs text-slate-500">{empty ? "无数据" : "展开查看"}</span>
      </summary>
      <pre className="max-h-[420px] overflow-auto border-t border-slate-800 p-3 text-xs leading-5 text-slate-300">
        {empty ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export default function RecordDetailsDrawer({ eventId, occurredAt, onClose }: Props) {
  const [record, setRecord] = useState<RecordDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRecord(null);
    const params = new URLSearchParams({ eventId: String(eventId), occurredAt });
    fetch(`/api/records/detail?${params.toString()}`, { cache: "no-store", signal: controller.signal })
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
    return `${record.cost.toFixed(8)} ${record.costCurrency ?? "USD"}`;
  }, [record]);

  async function copyRequestId() {
    if (!record?.requestId) return;
    try {
      await navigator.clipboard.writeText(record.requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

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
        className="flex h-full w-full max-w-5xl flex-col border-l border-slate-700 bg-slate-950 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-800 bg-slate-950/95 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${record?.isError ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                {record ? (record.isError ? "请求失败" : "请求成功") : "请求详情"}
              </span>
              {record?.statusCode ? <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">HTTP {record.statusCode}</span> : null}
              <span className="text-xs text-slate-500">事件 #{eventId}</span>
            </div>
            <h2 className="mt-2 truncate text-lg font-semibold text-white">{record?.model ?? "正在加载请求详情"}</h2>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
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

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex min-h-64 items-center justify-center gap-3 text-sm text-slate-400">
              <LoaderCircle className="h-5 w-5 animate-spin" /> 正在读取完整事件记录…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-4 text-sm text-rose-200">{error}</div>
          ) : record ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-xs text-slate-500">总耗时</div>
                  <div className="mt-1 text-xl font-semibold text-white">{record.latencyMs == null ? "—" : `${numberText(record.latencyMs)} ms`}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-xs text-slate-500">首 Token 延迟（TTFT）</div>
                  <div className="mt-1 text-xl font-semibold text-white">{record.ttftMs == null ? "—" : `${numberText(record.ttftMs)} ms`}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-xs text-slate-500">总 Tokens</div>
                  <div className="mt-1 text-xl font-semibold text-white">{numberText(record.totalTokens)}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-xs text-slate-500">费用</div>
                  <div className="mt-1 text-xl font-semibold text-white">{costLabel}</div>
                  <div className="mt-1 text-[11px] text-slate-500">{record.pricingStatus ?? "定价状态未知"}</div>
                </div>
              </div>

              <Section title="请求与路由" description="请求身份、调用方、CPA 路由和上游模型信息">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="Request ID" value={record.requestId} mono />
                  <Field label="Provider" value={record.provider} />
                  <Field label="API Group" value={record.apiGroupLabel} />
                  <Field label="API Group Key" value={record.apiGroupKey} mono />
                  <Field label="API Key（脱敏）" value={record.apiKeyMask ?? record.route} mono />
                  <Field label="Credential" value={record.credentialName} />
                  <Field label="Endpoint" value={record.endpoint} mono />
                  <Field label="Auth Type" value={record.authType} />
                  <Field label="Executor" value={record.executorType} />
                  <Field label="Access Provider" value={record.accessProvider} />
                  <Field label="Native Key" value={record.isNativeKey} />
                  <Field label="Source" value={record.originSystem ?? record.source ?? record.sourceEventKey} />
                  <Field label="采集实例" value={record.sourceInstanceId} mono />
                  <Field label="采集传输" value={record.sourceTransport} />
                  <Field label="CPA 原始事件 ID" value={record.sourceNativeId} mono />
                  <Field label="发生时间" value={timeText(record.occurredAt)} />
                  <Field label="入库时间" value={timeText(record.ingestedAt)} />
                  <Field label="API Key Mask" value={record.route} mono />
                </dl>              </Section>

              <Section title="模型与推理参数">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="请求模型" value={record.model} />
                  <Field label="模型别名" value={record.modelAlias} />
                  <Field label="响应模型" value={record.responseModel} />
                  <Field label="是否发生模型替换" value={record.modelSubstituted} />
                  <Field label="Reasoning Effort" value={record.reasoningEffort} />
                  <Field label="请求 Service Tier" value={record.serviceTier} />
                  <Field label="响应 Service Tier" value={record.responseServiceTier} />
                  <Field label="有效 Service Tier" value={record.effectiveServiceTier} />
                  <Field label="计费 Service Tier" value={record.billedServiceTier} />
                  <Field label="计费 Tier 来源" value={record.billedServiceTierSource} />
                  <Field label="Stream" value={record.stream} />
                  <Field label="Generate" value={record.generate} />
                </dl>
              </Section>

              <Section title="Token 与缓存用量" description="Reasoning Tokens 通常属于 Output Tokens 的子集，不应再次加到总量中">
                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  <Field label="Input Tokens" value={numberText(record.inputTokens)} />
                  <Field label="Output Tokens" value={numberText(record.outputTokens)} />
                  <Field label="Reasoning Tokens" value={numberText(record.reasoningTokens)} />
                  <Field label="Cached Tokens" value={numberText(record.cachedTokens)} />
                  <Field label="Cache Read Tokens" value={numberText(record.cacheReadTokens)} />
                  <Field label="Cache Creation / Write" value={numberText(record.cacheCreationTokens)} />
                  <Field label="Total Tokens" value={numberText(record.totalTokens)} />
                </dl>
                <div className="mt-3 space-y-2">
                  <JsonBlock title="Token Accounting" value={record.tokenAccounting} />
                  <JsonBlock title="Structured Usage" value={record.structuredUsage} />
                </div>
              </Section>

              <Section title="性能与执行上下文">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="Latency" value={record.latencyMs == null ? null : `${record.latencyMs} ms`} />
                  <Field label="TTFT" value={record.ttftMs == null ? null : `${record.ttftMs} ms`} />
                  <Field label="Session ID" value={record.sessionId} mono />
                  <Field label="Parent Session ID" value={record.parentSessionId} mono />
                  <Field label="Execution ID" value={record.executionId} mono />
                  <Field label="Trace ID" value={record.traceId} mono />
                  <Field label="Node Kind" value={record.nodeKind} />
                  <Field label="Fork" value={record.isFork} />
                  <Field label="Compaction" value={record.isCompaction} />
                </dl>
              </Section>

              <Section title="费用与定价" description="费用以纳单位持久化，避免展示层浮点数舍入影响账本">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="计算费用" value={costLabel} />
                  <Field label="Cost Nanos" value={record.costNanos == null ? null : numberText(record.costNanos)} mono />
                  <Field label="币种" value={record.costCurrency} />
                  <Field label="Pricing Status" value={record.pricingStatus} />
                  <Field label="Price Version ID" value={record.priceVersionId} />
                  <Field label="Source Price Version ID" value={record.sourcePriceVersionId} />
                </dl>
              </Section>

              <Section title="错误与诊断" description="错误正文与响应头来自已脱敏的 CPA 事件数据">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="结果" value={record.isError ? "失败" : "成功"} />
                  <Field label="HTTP Status" value={record.statusCode} />
                  <Field label="Fail Code" value={record.failCode} mono />
                  <Field label="Client IP" value={record.clientIp} mono />
                  <Field label="X-Forwarded-For" value={record.xForwardedFor} mono />
                  <Field label="User Agent" value={record.userAgent} />
                </dl>
                {record.failBody ? (
                  <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-rose-500/20 bg-rose-950/20 p-3 text-xs leading-5 text-rose-200">{record.failBody}</pre>
                ) : null}
                <div className="mt-3 space-y-2">
                  <JsonBlock title="Response Headers（已脱敏）" value={record.responseHeaders} />
                  <JsonBlock title="原始事件 Payload（已脱敏）" value={record.rawPayload} />
                </div>
              </Section>

            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
