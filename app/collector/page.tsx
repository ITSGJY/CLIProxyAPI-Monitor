"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

type StatusData = {
  instances: Array<{instanceId:string;displayName:string;enabled:boolean;state:string|null;healthy:boolean;leaseFresh:boolean;leaseExpiresAt:string|null;lastAttemptAt:string|null;lastSuccessAt:string|null;lastEventAt:string|null;transport:string|null;errorCode:string|null}>;
  inboxCounts: Record<string,{pending:number;processing:number;deadLetter:number}>;
  gaps: Array<{id:number;instanceId:string;detectedAt:string;startedAt:string|null;reason:string;estimatedMissingCount:number|null}>;
  attempts: Array<{instanceId:string;transport:string;status:string;received:number;persisted:number;completedAt:string|null}>;
  pricingCoverage: Record<string,{priced:number;unpriced:number;partial:number}>;
  generatedAt:string;
};

function date(value:string|null|undefined) { return value ? new Date(value).toLocaleString() : "—"; }
export default function CollectorPage() {
  const [data,setData] = useState<StatusData|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [loading,setLoading] = useState(true);
  async function refresh() {
    setLoading(true); setError(null);
    try { const response = await fetch("/api/collector/status",{cache:"no-store"}); const json = await response.json(); if(!response.ok) throw new Error(json.error||response.statusText); setData(json); }
    catch(e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(()=>{ void refresh(); },[]);
  return <main className="mx-auto max-w-7xl space-y-6 p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">采集与计费状态</h1><p className="mt-1 text-sm text-muted-foreground">Collector 心跳、Inbox 积压、采集缺口及历史价格覆盖率</p></div><button onClick={()=>void refresh()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" disabled={loading}><RefreshCw size={16}/>{loading?"刷新中":"刷新"}</button></header>
    {error&&<div className="rounded-lg border border-red-500/40 p-4 text-sm text-red-500">{error}</div>}
    {data&&<>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.instances.map(instance=><article key={instance.instanceId} className="rounded-xl border p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">{instance.displayName}</h2>{instance.healthy?<CheckCircle2 className="text-emerald-500"/>:<AlertTriangle className="text-amber-500"/>}</div><p className="mt-1 text-xs text-muted-foreground">{instance.instanceId}</p><p className="mt-3 text-sm">状态：{instance.state??"未启动"} · {instance.enabled?"已启用":"已禁用"}</p><p className="mt-1 text-sm">Lease：{instance.leaseFresh?"有效":"过期或缺失"} · {instance.transport??"—"}</p><p className="mt-1 text-sm">最近成功：{date(instance.lastSuccessAt)}</p><p className="mt-1 text-sm">最近事件：{date(instance.lastEventAt)}</p>{instance.errorCode&&<p className="mt-2 text-sm text-red-500">错误代码：{instance.errorCode}</p>}<div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded bg-muted p-2">待处理<strong className="block text-base">{data.inboxCounts[instance.instanceId]?.pending??0}</strong></div><div className="rounded bg-muted p-2">处理中<strong className="block text-base">{data.inboxCounts[instance.instanceId]?.processing??0}</strong></div><div className="rounded bg-muted p-2">死信<strong className="block text-base">{data.inboxCounts[instance.instanceId]?.deadLetter??0}</strong></div></div></article>)}</section>
      <section className="rounded-xl border p-4"><h2 className="mb-3 font-semibold">价格覆盖率</h2><div className="grid gap-3 md:grid-cols-3">{Object.entries(data.pricingCoverage).map(([currency,value])=>{const total=value.priced+value.unpriced+value.partial;return <div key={currency} className="rounded-lg bg-muted p-3"><div className="font-medium">{currency}</div><div className="mt-1 text-2xl">{total?((value.priced/total)*100).toFixed(2):"100.00"}%</div><p className="text-xs text-muted-foreground">已定价 {value.priced} · 未定价 {value.unpriced} · 部分 {value.partial}</p></div>})}</div></section>
      <section className="rounded-xl border p-4"><h2 className="mb-3 font-semibold">采集缺口</h2>{data.gaps.length===0?<p className="text-sm text-muted-foreground">没有记录到采集缺口</p>:<div className="divide-y">{data.gaps.map(gap=><div key={gap.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><div><div className="font-medium">{gap.reason}</div><div className="text-xs text-muted-foreground">{gap.instanceId} · 检测时间 {date(gap.detectedAt)}</div></div><div className="text-amber-500">估计缺失：{gap.estimatedMissingCount??"未知"}</div></div>)}</div>}</section>
      <section className="rounded-xl border p-4"><h2 className="mb-3 font-semibold">最近采集尝试</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-muted-foreground"><th className="py-2">实例</th><th>传输</th><th>结果</th><th>收到</th><th>持久化</th><th>时间</th></tr></thead><tbody>{data.attempts.slice(0,30).map((attempt,index)=><tr key={`${attempt.instanceId}-${index}`} className="border-b last:border-0"><td className="py-2">{attempt.instanceId}</td><td>{attempt.transport}</td><td>{attempt.status}</td><td>{attempt.received}</td><td>{attempt.persisted}</td><td>{date(attempt.completedAt)}</td></tr>)}</tbody></table></div></section>
      <p className="text-right text-xs text-muted-foreground">更新于 {date(data.generatedAt)}</p>
    </>}
  </main>;
}
