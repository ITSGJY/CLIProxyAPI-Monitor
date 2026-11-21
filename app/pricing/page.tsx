"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

type Offering = {
  providerId: string; modelId: string; name: string;
  inputPricePer1M: string | null; outputPricePer1M: string | null;
  cacheReadPricePer1M: string | null; cacheWritePricePer1M: string | null;
  contextLength?: number | null;
};
type ModelRow = {
  model: string; provider: string; requests: number; totalTokens: string;
  pricedRequests: number; pricingStatus: string; priceMode: string | null;
  price: any; link: any; matchStatus: string; matchKind: string | null;
  candidates: Offering[]; referenceCandidates: Offering[];
};
type PricingData = {
  summary: { observedModels: number; pricedModels: number; unpricedModels: number; ambiguousModels: number; catalogOfferings: number };
  models: ModelRow[]; prices: any[]; channels: any[]; channelVersions: any[]; syncState: any[]; snapshots: any[]; priceVersions: any[];
};
type PriceForm = { model: string; provider: string; serviceTier: string; input: string; cacheRead: string; output: string; cacheWrite: string; multiplier: string; tiers: string };

const emptyForm: PriceForm = { model: "", provider: "", serviceTier: "", input: "", cacheRead: "", output: "", cacheWrite: "", multiplier: "1", tiers: "[]" };
const inputClass = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500";
const labelClass = "block text-xs font-medium text-slate-400";
const panelClass = "rounded-xl border border-slate-800 bg-slate-900/70 p-5";
const buttonClass = "rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButtonClass = "rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50";

function money(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? "$" + number.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—";
}
function dateTime(value: unknown) {
  if (!value) return "从未";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { hour12: false });
}
function modeLabel(mode: string | null) {
  if (mode === "custom") return "Custom · 人工";
  if (mode === "linked") return "Linked · 已关联";
  if (mode === "auto") return "Auto · 自动";
  return "未定价";
}

export default function PricingPage() {
  const [data, setData] = useState<PricingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<PriceForm>(emptyForm);
  const [candidateSelection, setCandidateSelection] = useState<Record<string, string>>({});
  const [syncIntervalDrafts, setSyncIntervalDrafts] = useState<Record<string, string>>({});
  const [channelForm, setChannelForm] = useState({ channel: "", multiplier: "1", note: "" });
  const [previewForm, setPreviewForm] = useState({ model: "", provider: "", inputTokens: "100000", outputTokens: "10000", cacheReadTokens: "0", cacheWriteTokens: "0", serviceTier: "" });
  const [previewResult, setPreviewResult] = useState<any>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/pricing", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "无法读取价格目录");
      setData(body as PricingData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取价格目录失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadData(); }, [loadData]);

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data?.models ?? [];
    return (data?.models ?? []).filter((row) => row.model.toLowerCase().includes(query) || row.provider.toLowerCase().includes(query));
  }, [data, search]);

  const selectModel = (row: ModelRow) => {
    const price = row.price;
    setForm({
      model: row.model, provider: row.provider, serviceTier: price?.service_tier ?? "",
      input: price?.input_price_per_1m ?? "",
      cacheRead: price?.cached_input_price_per_1m ?? "",
      output: price?.output_price_per_1m ?? "",
      cacheWrite: price?.cache_write_price_per_1m ?? "",
      multiplier: price?.price_multiplier ?? "1",
      tiers: JSON.stringify(price?.tiers ?? [], null, 2)
    });
    setPreviewForm((current) => ({ ...current, model: row.model, provider: row.provider }));
  };

  const savePrice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save"); setError(""); setNotice("");
    try {
      const tiers = JSON.parse(form.tiers);
      if (!Array.isArray(tiers)) throw new Error("Tier 配置必须是 JSON 数组");
      const response = await fetch("/api/pricing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: form.model, provider: form.provider, serviceTier: form.serviceTier,
          inputPricePer1M: form.input, cachedInputPricePer1M: form.cacheRead,
          outputPricePer1M: form.output, cacheWritePricePer1M: form.cacheWrite,
          priceMultiplier: form.multiplier, tiers
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.[0]?.message || body.error || "保存价格失败");
      setNotice("已保存为 Custom 价格，并生成新的不可变价格版本。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存价格失败");
    } finally { setBusy(""); }
  };

  const sync = async (source: "models.dev" | "openrouter") => {
    setBusy(source); setError(""); setNotice("");
    try {
      const response = await fetch("/api/pricing/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || JSON.stringify(body.results ?? body));
      const summary = body.results?.map((item: any) => item.source + ": " + item.status + (item.modelCount !== undefined ? "，" + item.modelCount + " 个 Offering" : "")).join("；");
      setNotice(summary || "同步任务已完成。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步失败");
    } finally { setBusy(""); }
  };

  const saveSyncInterval = async (source: string, currentHours: number) => {
    const autoSyncIntervalHours = Number(syncIntervalDrafts[source] ?? currentHours);
    if (!Number.isInteger(autoSyncIntervalHours) || autoSyncIntervalHours < 0 || autoSyncIntervalHours > 168) {
      setError("自动同步间隔必须是 0–168 小时的整数。");
      return;
    }
    setBusy("interval:" + source); setError("");
    try {
      const response = await fetch("/api/pricing/sync", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, autoSyncIntervalHours })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.[0]?.message || body.error || "保存同步间隔失败");
      setNotice(source + " 自动同步间隔已更新为 " + autoSyncIntervalHours + " 小时。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存同步间隔失败");
    } finally { setBusy(""); }
  };

  const linkModel = async (row: ModelRow) => {
    const key = row.model + "|" + row.provider;
    const selected = candidateSelection[key] ?? (row.candidates[0] ? row.candidates[0].providerId + "|" + row.candidates[0].modelId : "");
    const parts = selected.split("|");
    if (!parts[0] || !parts[1]) { setError("请先选择一个明确的 models.dev Provider Offering。"); return; }
    setBusy("link:" + key); setError(""); setNotice("");
    try {
      const response = await fetch("/api/pricing/link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: row.model, provider: row.provider, upstreamProviderId: parts[0], upstreamModelId: parts.slice(1).join("|") })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "关联失败");
      setNotice(row.model + " 已关联到 " + parts[0] + "/" + parts.slice(1).join("|") + "。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "关联失败");
    } finally { setBusy(""); }
  };

  const unlinkModel = async (row: ModelRow) => {
    const key = row.model + "|" + row.provider;
    setBusy("unlink:" + key); setError("");
    try {
      const response = await fetch("/api/pricing/link", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: row.model, provider: row.provider })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "取消关联失败");
      setNotice("已解除 Linked 关系；下一次同步会重新执行安全 Auto 匹配。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消关联失败");
    } finally { setBusy(""); }
  };

  const saveChannel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy("channel"); setError("");
    try {
      const response = await fetch("/api/pricing/channels", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(channelForm)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存渠道倍率失败");
      setChannelForm({ channel: "", multiplier: "1", note: "" });
      setNotice("渠道倍率已保存并生成历史版本。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存渠道倍率失败");
    } finally { setBusy(""); }
  };

  const deleteChannel = async (channel: string) => {
    if (!window.confirm("删除渠道 " + channel + " 的倍率配置？历史倍率版本仍会保留。")) return;
    setBusy("channel-delete:" + channel);
    try {
      const response = await fetch("/api/pricing/channels", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "删除渠道失败");
      setNotice("渠道倍率已停用；历史请求仍引用原倍率版本。");
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除渠道失败");
    } finally { setBusy(""); }
  };

  const deletePrice = async () => {
    if (!form.model || !window.confirm("停用 " + form.model + " / " + (form.provider || "共享价格") + "？历史价格版本会保留。")) return;
    setBusy("delete-price");
    try {
      const response = await fetch("/api/pricing", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: form.model, provider: form.provider, serviceTier: form.serviceTier })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "停用价格失败");
      setNotice("当前价格已停用，历史版本未删除。");
      setForm(emptyForm);
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "停用价格失败");
    } finally { setBusy(""); }
  };

  const runPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy("preview"); setPreviewResult(null); setError("");
    try {
      const response = await fetch("/api/pricing/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...previewForm,
          inputTokens: Number(previewForm.inputTokens), outputTokens: Number(previewForm.outputTokens),
          cacheReadTokens: Number(previewForm.cacheReadTokens), cacheWriteTokens: Number(previewForm.cacheWriteTokens),
          occurredAt: new Date().toISOString()
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "试算失败");
      setPreviewResult(body.quote);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "试算失败");
    } finally { setBusy(""); }
  };

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100 xl:px-10">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">Pricing Center</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">模型价格体系</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-400">models.dev 原厂价格目录、CPA 模型关联、渠道倍率、条件价格和请求级成本快照。OpenRouter 只作为只读参考，不会覆盖主价格。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={secondaryButtonClass} disabled={Boolean(busy)} onClick={() => void sync("openrouter")}>{busy === "openrouter" ? "同步中…" : "更新 OpenRouter 参考"}</button>
            <button className={buttonClass} disabled={Boolean(busy)} onClick={() => void sync("models.dev")}>{busy === "models.dev" ? "同步中…" : "同步 models.dev"}</button>
          </div>
        </header>

        {error ? <div className="rounded-lg border border-rose-900 bg-rose-950/60 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
        {notice ? <div className="rounded-lg border border-emerald-900 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-200">{notice}</div> : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["CPA 已观测模型", data?.summary.observedModels ?? "—"],
            ["已定价", data?.summary.pricedModels ?? "—"],
            ["未定价", data?.summary.unpricedModels ?? "—"],
            ["待确认匹配", data?.summary.ambiguousModels ?? "—"],
            ["models.dev Offerings", data?.summary.catalogOfferings ?? "—"]
          ].map(([label, value]) => <div key={label} className={panelClass}><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p></div>)}
        </section>

        <section className={panelClass}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div><h2 className="text-lg font-semibold">模型价格覆盖与匹配</h2><p className="mt-1 text-xs text-slate-500">只按精确模型 ID、明确 Provider 或人工 Linked 关联；不进行后缀截断和模糊自动计价。</p></div>
            <input className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-500 md:max-w-xs" placeholder="搜索模型或 CPA 渠道…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[1280px] text-left text-sm">
              <thead className="border-b border-slate-800 text-xs text-slate-500"><tr><th className="px-3 py-3">模型 / CPA 渠道</th><th className="px-3 py-3">请求数</th><th className="px-3 py-3">价格模式</th><th className="px-3 py-3">匹配状态</th><th className="px-3 py-3">Input / M</th><th className="px-3 py-3">Cache Read / M</th><th className="px-3 py-3">Output / M</th><th className="px-3 py-3">Cache Write / M</th><th className="px-3 py-3">操作</th></tr></thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredModels.map((row) => {
                  const key = row.model + "|" + row.provider;
                  const selected = candidateSelection[key] ?? (row.candidates[0] ? row.candidates[0].providerId + "|" + row.candidates[0].modelId : "");
                  return (
                    <tr key={key} className="align-top hover:bg-slate-800/30">
                      <td className="px-3 py-3"><button className="text-left font-medium text-slate-100 hover:text-indigo-300" onClick={() => selectModel(row)}>{row.model}</button><p className="mt-1 text-xs text-slate-500">{row.provider || "共享渠道 / 未标记 Provider"}</p></td>
                      <td className="px-3 py-3 tabular-nums">{row.requests.toLocaleString()}</td>
                      <td className="px-3 py-3"><span className={row.priceMode === "custom" ? "text-amber-300" : row.priceMode === "linked" ? "text-sky-300" : row.priceMode === "auto" ? "text-emerald-300" : "text-slate-500"}>{modeLabel(row.priceMode)}</span></td>
                      <td className="px-3 py-3"><span className={row.matchStatus === "ambiguous" ? "text-amber-300" : row.matchStatus === "unmatched" ? "text-rose-300" : "text-emerald-300"}>{row.matchStatus === "ambiguous" ? "存在歧义" : row.matchStatus === "unmatched" ? "无精确匹配" : row.matchStatus === "linked" ? "人工关联" : "安全匹配"}</span>{row.matchKind ? <p className="mt-1 text-[11px] text-slate-600">{row.matchKind}</p> : null}{row.referenceCandidates[0] ? <p className="mt-1 text-[11px] text-slate-500">OpenRouter 参考：{money(row.referenceCandidates[0].inputPricePer1M)} / {money(row.referenceCandidates[0].outputPricePer1M)}</p> : null}</td>
                      <td className="px-3 py-3 tabular-nums">{money(row.price?.input_price_per_1m)}</td>
                      <td className="px-3 py-3 tabular-nums">{money(row.price?.cached_input_price_per_1m)}</td>
                      <td className="px-3 py-3 tabular-nums">{money(row.price?.output_price_per_1m)}</td>
                      <td className="px-3 py-3 tabular-nums">{money(row.price?.cache_write_price_per_1m)}</td>
                      <td className="px-3 py-3">
                        <div className="flex min-w-[260px] flex-col gap-2">
                          <button className={secondaryButtonClass} onClick={() => selectModel(row)}>编辑 / 试算</button>
                          {row.link ? <button className="text-left text-xs text-rose-300 hover:text-rose-200" disabled={Boolean(busy)} onClick={() => void unlinkModel(row)}>解除 Linked 关联</button> : row.candidates.length ? (
                            <div className="flex gap-2">
                              <select className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs" value={selected} onChange={(event) => setCandidateSelection((current) => ({ ...current, [key]: event.target.value }))}>
                                {row.candidates.map((candidate) => <option key={candidate.providerId + candidate.modelId} value={candidate.providerId + "|" + candidate.modelId}>{candidate.providerId}/{candidate.modelId}</option>)}
                              </select>
                              <button className={buttonClass} disabled={Boolean(busy)} onClick={() => void linkModel(row)}>关联</button>
                            </div>
                          ) : <span className="text-xs text-slate-600">可手动设置 Custom 价格</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && filteredModels.length === 0 ? <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-slate-500">没有匹配的模型记录。</td></tr> : null}
              </tbody>
            </table>
          </div>
          {loading ? <p className="mt-3 text-xs text-slate-500">正在读取价格目录…</p> : null}
        </section>

        <div className="grid gap-6 2xl:grid-cols-2">
          <section className={panelClass}>
            <div className="mb-4"><h2 className="text-lg font-semibold">价格编辑器</h2><p className="mt-1 text-xs text-slate-500">保存后进入 Custom 模式，自动同步不会覆盖。留空 Provider 表示共享价格。</p></div>
            <form onSubmit={savePrice} className="grid gap-3 sm:grid-cols-2">
              <label className={labelClass}>CPA 模型 ID<input required className={inputClass} value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} placeholder="例如 gpt-5.5" /></label>
              <label className={labelClass}>CPA 渠道（可选）<input className={inputClass} value={form.provider} onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))} placeholder="留空 = 共享价格" /></label>
              <label className={labelClass}>Service Tier（可选）<input className={inputClass} value={form.serviceTier} onChange={(event) => setForm((current) => ({ ...current, serviceTier: event.target.value }))} placeholder="留空 = 默认价格" /></label>
              <label className={labelClass}>普通输入（USD / 1M）<input required inputMode="decimal" className={inputClass} value={form.input} onChange={(event) => setForm((current) => ({ ...current, input: event.target.value }))} /></label>
              <label className={labelClass}>缓存读取（USD / 1M）<input required inputMode="decimal" className={inputClass} value={form.cacheRead} onChange={(event) => setForm((current) => ({ ...current, cacheRead: event.target.value }))} /></label>
              <label className={labelClass}>输出（USD / 1M）<input required inputMode="decimal" className={inputClass} value={form.output} onChange={(event) => setForm((current) => ({ ...current, output: event.target.value }))} /></label>
              <label className={labelClass}>缓存写入（USD / 1M）<input required inputMode="decimal" className={inputClass} value={form.cacheWrite} onChange={(event) => setForm((current) => ({ ...current, cacheWrite: event.target.value }))} /></label>
              <label className={labelClass}>模型倍率<input required inputMode="decimal" className={inputClass} value={form.multiplier} onChange={(event) => setForm((current) => ({ ...current, multiplier: event.target.value }))} /></label>
              <label className={labelClass + " sm:col-span-2"}>Tier 条件价格（JSON 数组）<textarea rows={7} className={inputClass + " font-mono text-xs"} value={form.tiers} onChange={(event) => setForm((current) => ({ ...current, tiers: event.target.value }))} placeholder={'[{"min_prompt_tokens":200000,"prompt_price_per_1m":3}]'} /></label>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button className={buttonClass} type="submit" disabled={busy === "save" || !form.model}>{busy === "save" ? "保存中…" : "保存 Custom 价格"}</button>
                <button className={secondaryButtonClass} type="button" onClick={() => setForm(emptyForm)}>清空</button>
                <button className="rounded-lg border border-rose-900 px-3 py-2 text-sm text-rose-300 hover:bg-rose-950/50 disabled:opacity-50" type="button" disabled={!form.model || busy === "delete-price"} onClick={() => void deletePrice()}>停用当前价格</button>
              </div>
            </form>
          </section>

          <section className={panelClass}>
            <div className="mb-4"><h2 className="text-lg font-semibold">请求成本试算</h2><p className="mt-1 text-xs text-slate-500">与 Collector 使用同一个 Quote Engine；按当前请求时间匹配有效价格版本，不写入 Usage 账本。</p></div>
            <form onSubmit={runPreview} className="grid gap-3 sm:grid-cols-2">
              <label className={labelClass}>模型 ID<input required className={inputClass} value={previewForm.model} onChange={(event) => setPreviewForm((current) => ({ ...current, model: event.target.value }))} /></label>
              <label className={labelClass}>CPA 渠道<input className={inputClass} value={previewForm.provider} onChange={(event) => setPreviewForm((current) => ({ ...current, provider: event.target.value }))} /></label>
              <label className={labelClass}>总输入 Token（含缓存）<input required type="number" min="0" className={inputClass} value={previewForm.inputTokens} onChange={(event) => setPreviewForm((current) => ({ ...current, inputTokens: event.target.value }))} /></label>
              <label className={labelClass}>输出 Token（含 Reasoning）<input required type="number" min="0" className={inputClass} value={previewForm.outputTokens} onChange={(event) => setPreviewForm((current) => ({ ...current, outputTokens: event.target.value }))} /></label>
              <label className={labelClass}>缓存读取 Token<input type="number" min="0" className={inputClass} value={previewForm.cacheReadTokens} onChange={(event) => setPreviewForm((current) => ({ ...current, cacheReadTokens: event.target.value }))} /></label>
              <label className={labelClass}>缓存写入 Token<input type="number" min="0" className={inputClass} value={previewForm.cacheWriteTokens} onChange={(event) => setPreviewForm((current) => ({ ...current, cacheWriteTokens: event.target.value }))} /></label>
              <label className={labelClass}>Service Tier<input className={inputClass} value={previewForm.serviceTier} onChange={(event) => setPreviewForm((current) => ({ ...current, serviceTier: event.target.value }))} placeholder="priority / fast" /></label>
              <div className="flex items-end"><button className={buttonClass + " w-full"} type="submit" disabled={busy === "preview" || !previewForm.model}>{busy === "preview" ? "计算中…" : "试算成本"}</button></div>
            </form>
            {previewResult ? <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950 p-4"><div className="flex items-center justify-between"><span className="text-xs text-slate-500">试算状态</span><span className={previewResult.status === "priced" ? "text-emerald-300" : "text-amber-300"}>{previewResult.status}</span></div><p className="mt-2 text-2xl font-semibold tabular-nums">{previewResult.costNanos ? money(Number(previewResult.costNanos) / 1000000000) : "暂无可用价格"}</p><pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px] text-slate-500">{JSON.stringify(previewResult, null, 2)}</pre></div> : null}
          </section>
        </div>

        <section className={panelClass}>
          <div className="mb-4"><h2 className="text-lg font-semibold">渠道倍率</h2><p className="mt-1 text-xs text-slate-500">作用于 CPA usage_events.provider；模型倍率与渠道倍率独立计算，倍率变更会生成不可变版本。</p></div>
          <form onSubmit={saveChannel} className="grid gap-3 md:grid-cols-[1fr_180px_2fr_auto]">
            <label className={labelClass}>CPA 渠道名称<input required className={inputClass} value={channelForm.channel} onChange={(event) => setChannelForm((current) => ({ ...current, channel: event.target.value }))} placeholder="例如 openai / my-relay" /></label>
            <label className={labelClass}>倍率<input required inputMode="decimal" className={inputClass} value={channelForm.multiplier} onChange={(event) => setChannelForm((current) => ({ ...current, multiplier: event.target.value }))} /></label>
            <label className={labelClass}>备注<input className={inputClass} value={channelForm.note} onChange={(event) => setChannelForm((current) => ({ ...current, note: event.target.value }))} placeholder="例如上游折扣 / 中转加价" /></label>
            <button className={buttonClass + " self-end"} disabled={busy === "channel"} type="submit">{busy === "channel" ? "保存中…" : "保存倍率"}</button>
          </form>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b border-slate-800 text-xs text-slate-500"><tr><th className="px-3 py-2">渠道</th><th className="px-3 py-2">倍率</th><th className="px-3 py-2">备注</th><th className="px-3 py-2">更新于</th><th /></tr></thead>
              <tbody className="divide-y divide-slate-800/80">
                {(data?.channels ?? []).map((channel) => <tr key={channel.channel}><td className="px-3 py-3 font-medium">{channel.channel}</td><td className="px-3 py-3 tabular-nums">{channel.multiplier}×</td><td className="px-3 py-3 text-slate-400">{channel.note || "—"}</td><td className="px-3 py-3 text-xs text-slate-500">{dateTime(channel.updated_at)}</td><td className="px-3 py-3 text-right"><button className="text-xs text-rose-300 hover:text-rose-200" onClick={() => void deleteChannel(channel.channel)}>停用</button></td></tr>)}
                {!data?.channels?.length ? <tr><td colSpan={5} className="px-3 py-5 text-center text-xs text-slate-600">尚未配置渠道倍率，默认使用 1×。</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="mt-4 border-t border-slate-800 pt-4">
            <h3 className="text-xs font-semibold text-slate-400">最近渠道倍率版本</h3>
            <div className="mt-2 space-y-2">
              {(data?.channelVersions ?? []).slice(0, 8).map((version) => (
                <div key={version.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-400">{version.channel} · {dateTime(version.effective_from)}</span>
                  <span className={version.available ? "text-slate-200" : "text-slate-500"}>{version.multiplier}×{version.available ? "" : " · 已停用"}</span>
                </div>
              ))}
              {!data?.channelVersions?.length ? <p className="text-xs text-slate-600">尚无渠道倍率变更记录。</p> : null}
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className={panelClass}>
            <h2 className="text-lg font-semibold">数据源同步状态</h2>
            <div className="mt-4 space-y-3">
              {(data?.syncState ?? []).map((state) => (
                <div key={state.source} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{state.source}</span>
                    <span className={state.latest_status === "success" || state.latest_status === "not_modified" ? "text-emerald-300" : state.latest_status === "failed" ? "text-rose-300" : "text-slate-500"}>{state.latest_status ?? "未同步"}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">最近成功：{dateTime(state.last_success_at)}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-xs text-slate-400">自动同步间隔
                      <input
                        type="number"
                        min="0"
                        max="168"
                        step="1"
                        className="ml-2 w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
                        value={syncIntervalDrafts[state.source] ?? String(state.auto_sync_interval_hours)}
                        onChange={(event) => setSyncIntervalDrafts((current) => ({ ...current, [state.source]: event.target.value }))}
                      />                    </label>
                    <button
                      className={secondaryButtonClass}
                      disabled={Boolean(busy)}
                      onClick={() => void saveSyncInterval(state.source, Number(state.auto_sync_interval_hours))}
                    >保存间隔</button>
                  </div>
                  <p className="mt-1 break-all text-[11px] text-slate-600">SHA256：{state.last_hash ?? "—"}</p>
                  <p className="mt-1 break-all text-[11px] text-slate-600">ETag：{state.etag ?? "—"} · Last-Modified：{state.last_modified ?? "—"}</p>
                  {state.last_error ? <p className="mt-2 text-xs text-rose-300">{state.last_error}</p> : null}
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2">{(data?.snapshots ?? []).slice(0, 8).map((snapshot) => <div key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="text-slate-400">{snapshot.source} · {dateTime(snapshot.fetched_at)} · {snapshot.model_count ?? 0} Offerings · {snapshot.matched_count ?? 0} 匹配 · {snapshot.ambiguous_count ?? 0} 歧义</span><span className={snapshot.status === "success" || snapshot.status === "not_modified" ? "text-emerald-400" : "text-rose-300"}>{snapshot.status}</span></div>)}</div>
          </section>
          <section className={panelClass}>
            <h2 className="text-lg font-semibold">最近价格版本</h2><p className="mt-1 text-xs text-slate-500">历史版本只追加；新价格不会改写已经锁定的请求成本。</p>
            <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto">
              {(data?.priceVersions ?? []).slice(0, 30).map((version) => <div key={version.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{version.model}</p><p className="mt-1 text-[11px] text-slate-500">{version.provider || "共享"} · {version.service_tier || "默认 Tier"} · {version.mode} · {version.source}</p></div><div className="shrink-0 text-right"><p className="text-xs tabular-nums text-slate-300">v{version.id}</p><p className="mt-1 text-[11px] text-slate-600">{dateTime(version.valid_from)}</p></div></div><p className="mt-2 break-words text-[11px] tabular-nums text-slate-400">Input {money(version.input_price_per_1m)} · Cache Read {money(version.cached_input_price_per_1m)} · Output {money(version.output_price_per_1m)} · Cache Write {money(version.cache_write_price_per_1m)} · Model × {version.price_multiplier}</p></div>)}
              {!data?.priceVersions?.length ? <p className="text-xs text-slate-600">暂无价格版本记录。</p> : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
