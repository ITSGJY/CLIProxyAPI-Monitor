"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { ArrowDown, ArrowUp, RefreshCw, SlidersHorizontal, X, CalendarRange, Columns3, GripVertical, Download, FileJson, Search, ChevronRight } from "lucide-react";
import RecordDetailsDrawer from "@/app/components/RecordDetailsDrawer";
import { formatNumberWithCommas } from "@/lib/utils";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { useAutoRefresh } from "@/app/components/AutoRefreshContext";
import { enUS, ja, ko, zhCN } from "date-fns/locale";

type UsageRecord = {
  id: number;
  occurredAt: string;
  route: string;
  source: string;
  credentialName: string;
  provider: string | null;
  apiGroupLabel: string | null;
  endpoint: string | null;
  requestId: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  executionId: string | null;
  traceId: string | null;
  nodeKind: string | null;
  isFork: boolean | null;
  isCompaction: boolean | null;
  authType: string | null;
  stream: boolean | null;
  generate: boolean | null;
  model: string;
  modelAlias: string | null;
  responseModel: string | null;
  modelSubstituted: boolean | null;
  reasoningEffort: string | null;
  executorType: string | null;
  accessProvider: string | null;
  isNativeKey: boolean | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number | null;
  ttftMs: number | null;
  serviceTier: string | null;
  statusCode: number | null;
  failCode: string | null;
  isError: boolean;
  cost: number | null;
  costNanos: number | null;
  costCurrency: string;
  pricingStatus: string;
};

type RecordsResponse = {
  items: UsageRecord[];
  nextCursor: string | null;
  totalCount?: number;
  filters?: { models: string[]; routes: string[]; sources: string[]; providers?: string[]; serviceTiers?: string[] };
};

type SortField =
  | "occurredAt" | "model" | "route" | "source" | "provider" | "requestId"
  | "totalTokens" | "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedTokens"
  | "cacheReadTokens" | "cacheCreationTokens" | "latencyMs" | "ttftMs" | "cost" | "isError"
  | "sessionId" | "parentSessionId" | "executionId" | "traceId" | "nodeKind" | "isFork" | "isCompaction";
type SortOrder = "asc" | "desc";
type SortKey = { field: SortField; order: SortOrder };

function recordsFilterKey(params: URLSearchParams) {
  const filters = new URLSearchParams(params);
  for (const key of ["limit", "sort", "cursor", "includeFilters", "includeTotal", "refresh"]) filters.delete(key);
  return filters.toString();
}

type ColumnKey =
  | "occurredAt" | "isError" | "provider" | "model" | "modelAlias" | "responseModel"
  | "requestId" | "route" | "credentialName" | "apiGroupLabel" | "endpoint" | "authType"
  | "executorType" | "accessProvider" | "isNativeKey" | "reasoningEffort" | "serviceTier"
  | "stream" | "generate" | "modelSubstituted" | "totalTokens" | "inputTokens"
  | "outputTokens" | "reasoningTokens" | "cachedTokens" | "cacheReadTokens"
  | "cacheCreationTokens" | "latencyMs" | "ttftMs" | "statusCode" | "cost"
  | "sessionId" | "parentSessionId" | "executionId" | "traceId" | "nodeKind" | "isFork" | "isCompaction"
  | "requestMode" | "cacheSummary";
type ColumnSetting = {
  key: ColumnKey;
  visible: boolean;
  width: number | null;
};

type AdvancedFilters = {
  q: string;
  requestId: string;
  apiGroupLabel: string;
  endpoint: string;
  authType: string;
  executorType: string;
  reasoningEffort: string;
  modelAlias: string;
  responseModel: string;
  statusCode: string;
  latencyMin: string;
  latencyMax: string;
  tokensMin: string;
  tokensMax: string;
  costStatus: string;
};

const EMPTY_ADVANCED_FILTERS: AdvancedFilters = {
  q: "",
  requestId: "",
  apiGroupLabel: "",
  endpoint: "",
  authType: "",
  executorType: "",
  reasoningEffort: "",
  modelAlias: "",
  responseModel: "",
  statusCode: "",
  latencyMin: "",
  latencyMax: "",
  tokensMin: "",
  tokensMax: "",
  costStatus: ""
};

const PAGE_SIZE = 60;
const COLUMN_SETTINGS_STORAGE_KEY = "records-column-settings-v4";
const LEGACY_COLUMN_SETTINGS_STORAGE_KEY = "records-column-settings-v3";
const OLDER_COLUMN_SETTINGS_STORAGE_KEY = "records-column-settings-v2";
// v3 default layout is used only to tell untouched settings apart from explicit preferences.
const LEGACY_DEFAULT_COLUMN_ORDER: ColumnKey[] = [
  "occurredAt", "isError", "provider", "model", "requestId", "sessionId", "parentSessionId", "executionId", "traceId",
  "nodeKind", "isFork", "isCompaction", "route", "credentialName", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens",  "cacheCreationTokens", "latencyMs", "ttftMs", "cost", "modelAlias", "responseModel",
  "apiGroupLabel", "endpoint", "authType", "executorType", "accessProvider", "isNativeKey",
  "reasoningEffort", "serviceTier", "stream", "generate", "modelSubstituted",
  "cachedTokens", "statusCode"
];
const LEGACY_DEFAULT_VISIBLE_COLUMNS = new Set<ColumnKey>([
  "occurredAt", "isError", "provider", "model", "requestId", "route", "credentialName",
  "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens",
  "cacheCreationTokens", "latencyMs", "ttftMs", "cost"
]);
// Follow OMC's reading order: identity, performance, accounting, caller.
// The full detailed columns remain in the column chooser and details drawer.
const COMPACT_COLUMN_ORDER: ColumnKey[] = [
  "occurredAt", "isError", "provider", "model", "requestMode", "latencyMs",
  "totalTokens", "cost", "cacheSummary", "route"
];
const DEFAULT_COLUMN_ORDER: ColumnKey[] = [
  ...COMPACT_COLUMN_ORDER,
  ...LEGACY_DEFAULT_COLUMN_ORDER.filter((key) => !COMPACT_COLUMN_ORDER.includes(key))
];
const DEFAULT_VISIBLE_COLUMNS = new Set<ColumnKey>(COMPACT_COLUMN_ORDER);
const COLUMN_LABELS: Record<ColumnKey, string> = {
  occurredAt: "时间",
  isError: "状态",
  provider: "提供商",
  model: "模型",
  requestMode: "模式",
  modelAlias: "模型别名",
  responseModel: "响应模型",
  requestId: "Request ID",
  route: "API Key",
  credentialName: "凭证",
  apiGroupLabel: "API Group",
  endpoint: "Endpoint",
  authType: "Auth Type",
  executorType: "Executor",
  accessProvider: "Access Provider",
  isNativeKey: "Native Key",
  reasoningEffort: "Reasoning Effort",
  serviceTier: "Service Tier",
  stream: "Stream",
  generate: "Generate",
  modelSubstituted: "模型替换",
  totalTokens: "总 Tokens",
  inputTokens: "输入",
  outputTokens: "输出",
  reasoningTokens: "思考",
  cachedTokens: "Cached",
  cacheReadTokens: "Cache Read",
  cacheSummary: "缓存",
  cacheCreationTokens: "Cache Write",
  latencyMs: "Latency",
  ttftMs: "TTFT",
  statusCode: "HTTP 状态码",  cost: "费用",
  sessionId: "Session ID",
  parentSessionId: "Parent Session ID",
  executionId: "Execution ID",
  traceId: "Trace ID",
  nodeKind: "Node Kind",
  isFork: "Fork",
  isCompaction: "Compaction"
};

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  occurredAt: 122, isError: 76, provider: 148, model: 218, requestMode: 90, modelAlias: 160,
  responseModel: 180, requestId: 220, route: 150, credentialName: 180,
  apiGroupLabel: 140, endpoint: 210, authType: 120, executorType: 130,
  accessProvider: 140, isNativeKey: 105, reasoningEffort: 130, serviceTier: 130,
  stream: 90, generate: 95, modelSubstituted: 105, totalTokens: 154,
  inputTokens: 95, outputTokens: 95, reasoningTokens: 105, cachedTokens: 100,
  cacheReadTokens: 110, cacheCreationTokens: 115, cacheSummary: 90, latencyMs: 102, ttftMs: 95,
  statusCode: 110, cost: 98,
  sessionId: 190, parentSessionId: 190, executionId: 190, traceId: 190,
  nodeKind: 120, isFork: 90, isCompaction: 110
};

const FIXED_WIDTH_COLUMNS = new Set<ColumnKey>(DEFAULT_COLUMN_ORDER.filter((key) => key !== "provider" && key !== "model"));
const COLUMN_MIN_WIDTH = 80;
const COLUMN_MAX_WIDTH = 420;

const NON_FIXED_CONTENT_MIN_WIDTHS: Record<ColumnKey, number> = {
  occurredAt: 120, isError: 76, provider: 136, model: 190, requestMode: 85, modelAlias: 130,
  responseModel: 150, requestId: 180, route: 150, credentialName: 150,
  apiGroupLabel: 120, endpoint: 150, authType: 100, executorType: 110,
  accessProvider: 120, isNativeKey: 95, reasoningEffort: 110, serviceTier: 110,
  stream: 80, generate: 85, modelSubstituted: 95, totalTokens: 105,
  inputTokens: 96, outputTokens: 96, reasoningTokens: 96, cachedTokens: 90,
  cacheReadTokens: 100, cacheCreationTokens: 105, cacheSummary: 90, latencyMs: 100, ttftMs: 90,
  statusCode: 95, cost: 105,
  sessionId: 170, parentSessionId: 170, executionId: 170, traceId: 170,
  nodeKind: 110, isFork: 80, isCompaction: 95
};

const SORT_FIELD_BY_COLUMN: Partial<Record<ColumnKey, SortField>> = {
  occurredAt: "occurredAt",
  model: "model",
  route: "route",
  credentialName: "source",
  provider: "provider",
  requestId: "requestId",
  totalTokens: "totalTokens",
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  reasoningTokens: "reasoningTokens",
  cachedTokens: "cachedTokens",
  cacheReadTokens: "cacheReadTokens",
  cacheSummary: "cacheReadTokens",
  cacheCreationTokens: "cacheCreationTokens",
  latencyMs: "latencyMs",
  ttftMs: "ttftMs",
  cost: "cost",
  isError: "isError",
  sessionId: "sessionId",
  parentSessionId: "parentSessionId",
  executionId: "executionId",
  traceId: "traceId",
  nodeKind: "nodeKind",
  isFork: "isFork",
  isCompaction: "isCompaction"
};

function isUntouchedLegacyColumnLayout(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== LEGACY_DEFAULT_COLUMN_ORDER.length) return false;
  return raw.every((item: { key?: unknown; visible?: unknown }, index: number) =>
    item?.key === LEGACY_DEFAULT_COLUMN_ORDER[index] &&
    (item.visible !== false) === LEGACY_DEFAULT_VISIBLE_COLUMNS.has(LEGACY_DEFAULT_COLUMN_ORDER[index])
  );
}

function defaultColumnSettings(): ColumnSetting[] {
  return DEFAULT_COLUMN_ORDER.map((key) => ({
    key,
    visible: DEFAULT_VISIBLE_COLUMNS.has(key),
    width: FIXED_WIDTH_COLUMNS.has(key) ? DEFAULT_COLUMN_WIDTHS[key] : null
  }));
}

function normalizeColumnSettings(raw: unknown): ColumnSetting[] {
  if (!Array.isArray(raw)) {
    return defaultColumnSettings();
  }

  const seen = new Set<ColumnKey>();
  const input = raw as Array<{ key?: unknown; visible?: unknown; width?: unknown }>;
  // A customized v3/v2 layout must not grow two surprise visible columns on upgrade.
  const oldLayout = !input.some((item) => item?.key === "requestMode" || item?.key === "cacheSummary");
  const ordered: ColumnSetting[] = [];

  for (const item of input) {
    const key = item?.key;
    if (typeof key !== "string" || !DEFAULT_COLUMN_ORDER.includes(key as ColumnKey)) continue;
    if (seen.has(key as ColumnKey)) continue;
    seen.add(key as ColumnKey);
    const parsedWidth = item?.width === null || item?.width === undefined ? Number.NaN : Number(item.width);
    const width = Number.isFinite(parsedWidth)
      ? Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, Math.round(parsedWidth)))
      : FIXED_WIDTH_COLUMNS.has(key as ColumnKey)
        ? DEFAULT_COLUMN_WIDTHS[key as ColumnKey]
        : null;
    ordered.push({ key: key as ColumnKey, visible: item?.visible !== false, width });
  }

  for (const key of DEFAULT_COLUMN_ORDER) {
    if (!seen.has(key)) {
      ordered.push({ key, visible: DEFAULT_VISIBLE_COLUMNS.has(key) && !(oldLayout && (key === "requestMode" || key === "cacheSummary")), width: FIXED_WIDTH_COLUMNS.has(key) ? DEFAULT_COLUMN_WIDTHS[key] : null });
    }
  }
  return ordered;
}

const TOKEN_COLORS = {
  input: "#fb7185",
  output: "#4ade80",
  reasoning: "#fbbf24",
  cached: "#c084fc"
};
const RIGHT_ALIGNED_COLUMNS = new Set<ColumnKey>([
  "latencyMs", "ttftMs", "totalTokens", "inputTokens", "outputTokens",
  "reasoningTokens", "cachedTokens", "cacheSummary", "cacheReadTokens",
  "cacheCreationTokens", "cost", "statusCode"
]);

function formatTimestamp(ts: string) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "-";
  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleString("zh-CN", {
    year: includeYear ? "2-digit" : undefined,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatCost(value: number) {
  // 0 值显示为 $0，非0值保留5位小数
  if (value === 0) return "$0";
  return `$${value.toFixed(5)}`;
}
function formatCompactTokens(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 1 : 2) + " s" : Math.round(value) + " ms";
}

function formatDateInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeDisplay(value: string) {
  if (!value) return value;
  return value.replace("T", " ");
}

function parseDateTimeInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const time = value.includes("T") ? value.split("T")[1] ?? "00:00" : "00:00";
  return { date, time };
}

function SkeletonRow() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="h-3 w-1/3 rounded bg-slate-700/60" />
      <div className="mt-3 h-3 w-2/3 rounded bg-slate-700/60" />
    </div>
  );
}

function SortHeader({
  label,
  priority,
  order,
  showPriority,
  onClick
}: {
  label: string;
  priority?: number;
  order?: SortOrder;
  showPriority?: boolean;
  onClick: () => void;
}) {
  const active = priority !== undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? "" : undefined}
      className={`inline-flex items-center gap-1 font-semibold transition ${active ? "text-white" : "text-slate-300 hover:text-white"}`}
    >
      <span>{label}</span>
      {active && order ? (
        order === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
      ) : null}
      {active && showPriority && priority !== undefined ? (
        <span className="text-[10px] font-bold leading-none opacity-60">{priority}</span>
      ) : null}
    </button>
  );
}

export default function RecordsPage() {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const refreshStatusTimerRef = useRef<number | null>(null);
  const [refreshStatusClosing, setRefreshStatusClosing] = useState(false);

  // 自动刷新由仪表盘统一控制；Records 仅继承开关与频率。
  const { autoRefresh } = useAutoRefresh();
  const [refreshPreset, setRefreshPreset] = useState("60");
  const [customIntervalInput, setCustomIntervalInput] = useState("60");
  const [customIntervalUnit, setCustomIntervalUnit] = useState<"s" | "m">("s");
  const [autoRefreshSettingsReady, setAutoRefreshSettingsReady] = useState(false);
  const autoRefreshWorkerRef = useRef<Worker | null>(null);
  const refreshRecordsRef = useRef<() => Promise<void>>(async () => {});
  const pendingImmediateAutoRefreshRef = useRef(false);
  const [models, setModels] = useState<string[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [routeInput, setRouteInput] = useState("");
  const [sourceInput, setSourceInput] = useState("");
  const [providerInput, setProviderInput] = useState("");
  const [serviceTierInput, setServiceTierInput] = useState("");
  const [statusInput, setStatusInput] = useState("");
  const [currencyInput, setCurrencyInput] = useState("");
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilters>({ ...EMPTY_ADVANCED_FILTERS });
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [rangePickerOpen, setRangePickerOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [timeStart, setTimeStart] = useState("00:00");
  const [timeEnd, setTimeEnd] = useState("23:59");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const rangePickerRef = useRef<HTMLDivElement | null>(null);

  const [appliedModel, setAppliedModel] = useState<string>("");
  const [appliedRoute, setAppliedRoute] = useState<string>("");
  const [appliedSource, setAppliedSource] = useState<string>("");
  const [appliedProvider, setAppliedProvider] = useState<string>("");
  const [appliedServiceTier, setAppliedServiceTier] = useState<string>("");
  const [appliedStatus, setAppliedStatus] = useState<string>("");
  const [appliedCurrency, setAppliedCurrency] = useState<string>("");
  const [appliedAdvancedFilters, setAppliedAdvancedFilters] = useState<AdvancedFilters>({ ...EMPTY_ADVANCED_FILTERS });
  const [appliedStart, setAppliedStart] = useState<string>("");
  const [appliedEnd, setAppliedEnd] = useState<string>("");

  const [sortKeys, setSortKeys] = useState<SortKey[]>([{ field: "occurredAt", order: "desc" }]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [columnSettings, setColumnSettings] = useState<ColumnSetting[]>(defaultColumnSettings);
  const [columnSettingsReady, setColumnSettingsReady] = useState(false);
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<{ id: number; occurredAt: string } | null>(null);
  const [tableContainerWidth, setTableContainerWidth] = useState(0);
  const columnPanelRef = useRef<HTMLDivElement | null>(null);
  const tableWrapperRef = useRef<HTMLDivElement | null>(null);
  const resizingColumnRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);
  const draggingColumnRef = useRef<ColumnKey | null>(null);
  const [dragIndicator, setDragIndicator] = useState<{ key: ColumnKey; position: "before" | "after" } | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const totalRecordsRef = useRef<number | null>(null);
  const totalRecordsFilterKeyRef = useRef<string | null>(null);
  const columnSettingMap = useMemo(
    () => new Map<ColumnKey, ColumnSetting>(columnSettings.map((item) => [item.key, item])),
    [columnSettings]
  );
  const visibleColumns = useMemo(
    () => columnSettings.filter((item) => item.visible).map((item) => item.key),
    [columnSettings]
  );
  const visibleColumnCount = visibleColumns.length;

  const toggleColumnVisibility = useCallback((key: ColumnKey) => {
    setColumnSettings((prev) => {
      const next = prev.map((item) => (item.key === key ? { ...item, visible: !item.visible } : item));
      if (next.filter((item) => item.visible).length === 0) return prev;

      // 每次列显隐变更后，非关键列重置为 auto，触发一次自适应宽度。
      return next.map((item) => (FIXED_WIDTH_COLUMNS.has(item.key) ? item : { ...item, width: null }));
    });
  }, []);

  const reorderColumns = useCallback((fromKey: ColumnKey, toKey: ColumnKey, position: "before" | "after") => {
    setColumnSettings((prev) => {
      const fromIdx = prev.findIndex((item) => item.key === fromKey);
      if (fromIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      const targetIdx = next.findIndex((item) => item.key === toKey);
      if (targetIdx < 0) return prev;
      const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
      next.splice(insertIdx, 0, moved);
      return next;
    });
  }, []);

  const onColumnDragStart = useCallback((key: ColumnKey) => {
    draggingColumnRef.current = key;
    setDragIndicator(null);
  }, []);

  const onColumnDragOver = useCallback((targetKey: ColumnKey, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "before" | "after" = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDragIndicator((prev) => {
      if (prev?.key === targetKey && prev.position === position) return prev;
      return { key: targetKey, position };
    });
  }, []);

  const onColumnDrop = useCallback((targetKey: ColumnKey, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceKey = draggingColumnRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "before" | "after" = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (sourceKey && sourceKey !== targetKey) {
      reorderColumns(sourceKey, targetKey, position);
    }
    draggingColumnRef.current = null;
    setDragIndicator(null);
  }, [reorderColumns]);

  const onColumnDragEnd = useCallback(() => {
    draggingColumnRef.current = null;
    setDragIndicator(null);
  }, []);

  const setColumnWidth = useCallback((key: ColumnKey, width: number) => {
    const nextWidth = Math.min(COLUMN_MAX_WIDTH, Math.max(COLUMN_MIN_WIDTH, Math.round(width)));
    setColumnSettings((prev) => prev.map((item) => (item.key === key ? { ...item, width: nextWidth } : item)));
  }, []);

  const getBaseColumnWidth = useCallback(
    (key: ColumnKey) => {
      const width = columnSettingMap.get(key)?.width;
      if (width !== undefined && width !== null) return width;
      return DEFAULT_COLUMN_WIDTHS[key];
    },
    [columnSettingMap]
  );

  const adaptiveWidthMap = useMemo(() => {
    const result = new Map<ColumnKey, number>();
    if (visibleColumns.length === 0) return result;

    const fixedColumns = visibleColumns.filter((key) => FIXED_WIDTH_COLUMNS.has(key));
    const nonFixedColumns = visibleColumns.filter((key) => !FIXED_WIDTH_COLUMNS.has(key));

    let usedWidth = 0;

    for (const key of fixedColumns) {
      const width = getBaseColumnWidth(key);
      result.set(key, width);
      usedWidth += width;
    }

    const manualNonFixed: ColumnKey[] = [];
    const autoNonFixed: ColumnKey[] = [];

    for (const key of nonFixedColumns) {
      const setting = columnSettingMap.get(key);
      if (setting?.width !== null && setting?.width !== undefined) {
        manualNonFixed.push(key);
      } else {
        autoNonFixed.push(key);
      }
    }

    for (const key of manualNonFixed) {
      const minRequired = NON_FIXED_CONTENT_MIN_WIDTHS[key];
      const width = Math.max(getBaseColumnWidth(key), minRequired);
      result.set(key, width);
      usedWidth += width;
    }

    if (autoNonFixed.length === 0) {
      return result;
    }

    const available = tableContainerWidth > 0 ? tableContainerWidth - 8 : 0;
    const minTotal = autoNonFixed.reduce((sum, key) => sum + NON_FIXED_CONTENT_MIN_WIDTHS[key], 0);
    const remaining = Math.max(0, available - usedWidth);

    if (remaining <= minTotal || available <= 0) {
      for (const key of autoNonFixed) {
        result.set(key, NON_FIXED_CONTENT_MIN_WIDTHS[key]);
      }
      return result;
    }

    const extraPerColumn = Math.floor((remaining - minTotal) / autoNonFixed.length);
    for (const key of autoNonFixed) {
      result.set(key, NON_FIXED_CONTENT_MIN_WIDTHS[key] + extraPerColumn);
    }

    return result;
  }, [visibleColumns, getBaseColumnWidth, columnSettingMap, tableContainerWidth]);

  const beginResizeColumn = useCallback(
    (key: ColumnKey, event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const current = columnSettingMap.get(key);
      if (!current) return;
      const currentRenderedWidth = Math.round(event.currentTarget.parentElement?.getBoundingClientRect().width ?? DEFAULT_COLUMN_WIDTHS[key]);

      resizingColumnRef.current = {
        key,
        startX: event.clientX,
        startWidth: currentRenderedWidth
      };

      const onMouseMove = (moveEvent: MouseEvent) => {
        const resizing = resizingColumnRef.current;
        if (!resizing) return;
        const delta = moveEvent.clientX - resizing.startX;
        setColumnWidth(resizing.key, resizing.startWidth + delta);
      };

      const onMouseUp = () => {
        resizingColumnRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [columnSettingMap, setColumnWidth]
  );

  const isEmpty = !loading && records.length === 0;
  const loadingEmpty = loading && records.length === 0;

  const buildParams = useCallback(
    (cursorValue?: string | null, includeFilters?: boolean, includeTotal?: boolean, trackRefresh?: boolean) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("sort", sortKeys.map(k => `${k.field}:${k.order}`).join(","));
      if (cursorValue) params.set("cursor", cursorValue);
      if (appliedModel) params.set("model", appliedModel);
      if (appliedRoute) params.set("route", appliedRoute);
      if (appliedSource) params.set("source", appliedSource);
      if (appliedProvider) params.set("provider", appliedProvider);
      if (appliedServiceTier) params.set("serviceTier", appliedServiceTier);
      if (appliedStatus) params.set("status", appliedStatus);
      if (appliedCurrency) params.set("currency", appliedCurrency);
      for (const [key, value] of Object.entries(appliedAdvancedFilters)) {
        const normalized = value.trim();
        if (normalized) params.set(key, normalized);
      }
      if (appliedStart) params.set("start", new Date(appliedStart).toISOString());
      if (appliedEnd) params.set("end", new Date(appliedEnd).toISOString());
      if (includeFilters) params.set("includeFilters", "1");
      if (includeTotal) params.set("includeTotal", "1");
      if (trackRefresh) params.set("refresh", "1");
      return params;
    },
    [sortKeys, appliedModel, appliedRoute, appliedSource, appliedProvider, appliedServiceTier, appliedStatus, appliedCurrency, appliedAdvancedFilters, appliedStart, appliedEnd]
  );

  const exportRecords = useCallback((format: "csv" | "json") => {
    const params = buildParams(null, false);
    params.delete("limit");
    params.delete("sort");
    params.delete("cursor");
    params.set("format", format);
    window.location.assign(`/api/records/export?${params.toString()}`);
  }, [buildParams]);

  const fetchRecords = useCallback(
    async (opts: { cursor?: string | null; append?: boolean; includeFilters?: boolean; includeTotal?: boolean; trackRefresh?: boolean } = {}): Promise<boolean> => {
      if (loadingRef.current) return false;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const params = buildParams(opts.cursor, opts.includeFilters, opts.includeTotal, opts.trackRefresh);
        const filterKey = recordsFilterKey(params);
        const res = await fetch(`/api/records?${params.toString()}`, { cache: "no-store" });
        const data: RecordsResponse & { error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        setCursor(data.nextCursor ?? null);
        setHasMore(Boolean(data.nextCursor));
        setRecords((prev) => (opts.append ? [...prev, ...data.items] : data.items));
        setHasLoaded(true);
        if (data.filters?.models?.length) setModels(data.filters.models);
        if (data.filters?.routes?.length) setRoutes(data.filters.routes);
        if (data.filters?.sources?.length) setSources(data.filters.sources);
        if (typeof data.totalCount === "number" && Number.isFinite(data.totalCount)) {
          const previousTotal = totalRecordsRef.current;
          if (opts.trackRefresh) {
            const delta = previousTotal === null || totalRecordsFilterKeyRef.current !== filterKey ? null : data.totalCount - previousTotal;
            setRefreshStatus(delta === null
              ? `当前筛选共 ${formatNumberWithCommas(data.totalCount)} 条记录`
              : delta > 0
                ? `新增 ${formatNumberWithCommas(delta)} 条记录`
                : "暂无新增数据");
            setRefreshStatusClosing(false);
          }
          totalRecordsRef.current = data.totalCount;
          totalRecordsFilterKeyRef.current = filterKey;
        }
        return true;
      } catch (err) {
        setError((err as Error).message || "加载失败");
        return false;
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [buildParams]
  );
  const closeRefreshStatus = useCallback(() => {
    if (refreshStatusTimerRef.current !== null) {
      window.clearTimeout(refreshStatusTimerRef.current);
      refreshStatusTimerRef.current = null;
    }
    setRefreshStatusClosing(true);
    setTimeout(() => {
      setRefreshStatus(null);
      setRefreshStatusClosing(false);
    }, 400);
  }, []);

  useEffect(() => {
    if (!refreshStatus) return;
    if (refreshStatusTimerRef.current !== null) {
      window.clearTimeout(refreshStatusTimerRef.current);
    }
    refreshStatusTimerRef.current = window.setTimeout(() => {
      closeRefreshStatus();
      refreshStatusTimerRef.current = null;
    }, 10000);
    return () => {
      if (refreshStatusTimerRef.current !== null) {
        window.clearTimeout(refreshStatusTimerRef.current);
        refreshStatusTimerRef.current = null;
      }
    };
  }, [refreshStatus, closeRefreshStatus]);
  const resetAndFetch = useCallback(
    (includeFilters?: boolean) => {
      setRecords([]);
      setCursor(null);
      setHasMore(true);
      const filterKey = recordsFilterKey(buildParams(null, false));
      const includeTotal = totalRecordsRef.current === null || totalRecordsFilterKeyRef.current !== filterKey;
      fetchRecords({ cursor: null, append: false, includeFilters, includeTotal });
    },
    [buildParams, fetchRecords]
  );

  const refreshRecords = useCallback(async () => {
    if (loadingRef.current) return;
    setRefreshStatus(null);
    setRefreshStatusClosing(false);
    await fetchRecords({ cursor: null, append: false, includeTotal: true, trackRefresh: true });
  }, [fetchRecords]);

  refreshRecordsRef.current = refreshRecords;

  // 刷新频率沿用仪表盘保存的设置，自动刷新开关由共享状态控制。
  useEffect(() => {
    const saved = window.localStorage.getItem("autoRefreshSettings");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.preset) setRefreshPreset(parsed.preset);
        if (parsed.custom) setCustomIntervalInput(parsed.custom);
        if (parsed.unit === "m") setCustomIntervalUnit("m");
      } catch {}
    }
    setAutoRefreshSettingsReady(true);
  }, []);

  // Records 页面只在自身挂载期间运行 Worker；离开页面后自动停止。
  useEffect(() => {
    if (typeof window === "undefined" || typeof Worker === "undefined") return;
    const worker = new Worker("/auto-refresh-worker.js");
    autoRefreshWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "tick") {
        void refreshRecordsRef.current();
      }
    };
    return () => {
      worker.postMessage({ type: "stop" });
      worker.terminate();
      autoRefreshWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = autoRefreshWorkerRef.current;
    if (!worker || !autoRefreshSettingsReady) return;
    if (autoRefresh) {
      const intervalMs = refreshPreset === "custom"
        ? Math.max(customIntervalUnit === "m" ? 1 : 5, Number(customIntervalInput) || (customIntervalUnit === "m" ? 1 : 60)) * (customIntervalUnit === "m" ? 60_000 : 1000)
        : Number(refreshPreset) * 1000;
      worker.postMessage({ type: "start", interval: intervalMs });
    } else {
      worker.postMessage({ type: "stop" });
    }
  }, [autoRefresh, autoRefreshSettingsReady, refreshPreset, customIntervalInput, customIntervalUnit]);

  // 进入 Records 时若仪表盘已开启自动刷新，先立即更新一次。
  useEffect(() => {
    pendingImmediateAutoRefreshRef.current = autoRefresh;
  }, [autoRefresh]);

  useEffect(() => {
    if (!autoRefresh || loading || !pendingImmediateAutoRefreshRef.current) return;
    pendingImmediateAutoRefreshRef.current = false;
    void refreshRecords();
  }, [autoRefresh, loading, refreshRecords]);
  useEffect(() => {
    resetAndFetch(true);
  }, [resetAndFetch]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    if (!hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && hasMore && !loadingRef.current) {
          fetchRecords({ cursor, append: true });
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [cursor, fetchRecords, hasMore, loading]);

  const handleSort = useCallback((field: SortField) => {
    setSortKeys(prev => {
      const idx = prev.findIndex(k => k.field === field);
      if (idx !== -1) {
        const current = prev[idx];
        if (current.order === "asc") {
          // 第三次点击：移除（多键时）或循环回 desc（唯一键时）
          // occurredAt 列不允许移除，始终保留
          if (prev.length > 1 && field !== "occurredAt") return prev.filter((_, i) => i !== idx);
          return prev.map((k, i) => i === idx ? { ...k, order: "desc" } : k);
        }
        // 第二次点击： desc → asc
        return prev.map((k, i) => i === idx ? { ...k, order: "asc" } : k);
      }
      // 第一次点击：插入头部为主键
      return [{ field, order: "desc" }, ...prev];
    });
  }, []);

  useEffect(() => {
    resetAndFetch(false);
  }, [sortKeys, resetAndFetch]);

  const updateAdvancedFilter = (key: keyof AdvancedFilters, value: string) => {
    setAdvancedFilters((previous) => ({ ...previous, [key]: value }));
  };

  const applyFilters = (overrides?: { model?: string; route?: string; source?: string; start?: string; end?: string }) => {
    const nextModel = (overrides?.model ?? modelInput).trim();
    const nextRoute = (overrides?.route ?? routeInput).trim();
    const nextSource = (overrides?.source ?? sourceInput).trim();
    const nextStart = overrides?.start ?? startInput;
    const nextEnd = overrides?.end ?? endInput;
    setAppliedModel(nextModel);
    setAppliedRoute(nextRoute);
    setAppliedSource(nextSource);
    setAppliedProvider(providerInput.trim());
    setAppliedServiceTier(serviceTierInput.trim());
    setAppliedStatus(statusInput);
    setAppliedCurrency(currencyInput.trim().toUpperCase());
    setAppliedAdvancedFilters({ ...advancedFilters });
    setAppliedStart(nextStart);
    setAppliedEnd(nextEnd);
  };

  const applyModelOption = (val: string) => {
    setModelInput(val);
    setAppliedModel(val.trim());
  };

  const applyRouteOption = (val: string) => {
    setRouteInput(val);
    setAppliedRoute(val.trim());
  };

  const applySourceOption = (val: string) => {
    setSourceInput(val);
    setAppliedSource(val.trim());
  };

  useEffect(() => {
    resetAndFetch(false);
  }, [appliedModel, appliedRoute, appliedSource, appliedProvider, appliedServiceTier, appliedStatus, appliedCurrency, appliedAdvancedFilters, appliedStart, appliedEnd, resetAndFetch]);

  const statusTone = useCallback((isError: boolean) => {
    return isError
      ? "bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/40"
      : "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40";
  }, []);

  const providerTone = useCallback((provider: string | null) => {
    const val = (provider || "").trim().toLowerCase();

    // 指定 provider（无视大小写）
    if (val.includes("geminicli") || val.includes("gemini")) {
      return "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40";
    }
    if (val.includes("vertex")) return "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40";
    if (val.includes("aistudio") || val.includes("ai studio")) {
      return "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-500/40";
    }
    if (val.includes("antigravity")) {
      return "bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-500/40";
    }
    if (val.includes("claude") || val.includes("anthropic")) {
      return "bg-orange-500/20 text-orange-200 ring-1 ring-orange-500/40";
    }
    if (val.includes("codex") || val.includes("openai")) {
      return "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/40";
    }
    if (val.includes("qwen") || val.includes("aliyun") || val.includes("dashscope")) {
      return "bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40";
    }
    if (val.includes("kimi") || val.includes("moonshot")) {
      return "bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/40";
    }
    if (val.includes("iflow") || val.includes("i-flow")) {
      return "bg-lime-500/20 text-lime-200 ring-1 ring-lime-500/40";
    }

    // 兼容历史 provider
    if (val.includes("openrouter")) return "bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/40";
    if (val.includes("google")) return "bg-blue-500/20 text-blue-200 ring-1 ring-blue-500/40";
    if (val.includes("azure")) return "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-500/40";
    if (val.includes("deepseek")) return "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40";
    if (val.includes("xai") || val.includes("grok")) return "bg-purple-500/20 text-purple-200 ring-1 ring-purple-500/40";
    return "bg-slate-700/60 text-slate-300 ring-1 ring-slate-600";
  }, []);

  const renderHeaderByColumn = useCallback(
    (columnKey: ColumnKey) => {
      const sortTarget = SORT_FIELD_BY_COLUMN[columnKey];
      if (!sortTarget) {
        return <span className="font-semibold text-slate-300">{COLUMN_LABELS[columnKey]}</span>;
      }

      const keyIdx = sortKeys.findIndex(k => k.field === sortTarget);
      const priority = keyIdx !== -1 ? keyIdx + 1 : undefined;
      const order = keyIdx !== -1 ? sortKeys[keyIdx].order : undefined;
      return (
        <SortHeader
          label={COLUMN_LABELS[columnKey]}
          priority={priority}
          order={order}
          showPriority={sortKeys.length > 1}
          onClick={() => handleSort(sortTarget)}
        />
      );
    },
    [sortKeys, handleSort]
  );

  const renderCellByColumn = useCallback(
    (columnKey: ColumnKey, row: UsageRecord) => {
      const muted = <span className="text-slate-600">—</span>;
      const textCell = (value: string | null, maxWidth = 180) => value
        ? <span className="block truncate text-slate-300" style={{ maxWidth }} title={value}>{value}</span>
        : muted;
      const numberCell = (value: number | null, suffix = "") => value === null
        ? muted
        : <span className="tabular-nums text-slate-300">{formatNumberWithCommas(value)}{suffix}</span>;
      const booleanCell = (value: boolean | null) => value === null
        ? muted
        : <span className={value ? "text-emerald-300" : "text-slate-400"}>{value ? "是" : "否"}</span>;

      switch (columnKey) {
        case "occurredAt": {
          const timestamp = formatTimestamp(row.occurredAt);
          const splitAt = timestamp.lastIndexOf(" ");
          return (
            <time dateTime={row.occurredAt} title={timestamp} className="block min-w-0 tabular-nums">
              <span className="block text-xs font-medium text-slate-100">{splitAt < 0 ? timestamp : timestamp.slice(0, splitAt)}</span>
              {splitAt >= 0 ? <span className="block text-[11px] text-slate-500">{timestamp.slice(splitAt + 1)}</span> : null}
            </time>
          );
        }
        case "isError":
          return (
            <span className={"inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium " + statusTone(row.isError)}>
              <span className={"h-1.5 w-1.5 rounded-full " + (row.isError ? "bg-rose-300" : "bg-sky-300")} />
              {row.isError ? "失败" : "成功"}
            </span>
          );
        case "provider":
          return (
            <span className={"inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-xs font-medium " + providerTone(row.provider)} title={row.provider || ""}>
              <span className="truncate">{row.provider || "—"}</span>
            </span>
          );
        case "model":
          return (
            <div className="min-w-0 max-w-full" title={row.model}>
              <div className="truncate text-[13px] font-semibold text-slate-100">{row.model}</div>
              {row.modelSubstituted && row.responseModel && row.responseModel !== row.model ? (
                <div className="truncate text-[11px] text-indigo-300" title={"响应模型：" + row.responseModel}>
                  {"↳ " + row.responseModel}
                </div>
              ) : row.modelAlias && row.modelAlias !== row.model ? (
                <div className="truncate text-[11px] text-slate-500" title={"模型别名：" + row.modelAlias}>
                  {row.modelAlias}
                </div>
              ) : null}
            </div>
          );
        case "requestMode":
          return (
            <div className="min-w-0 text-xs">
              <div className="text-slate-200">{row.stream === null ? "—" : row.stream ? "流式" : "非流式"}</div>
              {row.reasoningEffort ? (
                <div className="truncate text-[11px] text-slate-500" title={"推理强度：" + row.reasoningEffort}>
                  {row.reasoningEffort}
                </div>
              ) : row.generate === false ? (
                <div className="text-[11px] text-slate-500">预检</div>
              ) : null}
            </div>
          );
        case "modelAlias": return textCell(row.modelAlias, 160);
        case "responseModel": return textCell(row.responseModel, 180);
        case "requestId": return <span className="block max-w-[220px] truncate font-mono text-xs text-indigo-200" title={row.requestId ?? ""}>{row.requestId || "—"}</span>;
        case "sessionId": return textCell(row.sessionId, 190);
        case "parentSessionId": return textCell(row.parentSessionId, 190);
        case "executionId": return textCell(row.executionId, 190);
        case "traceId": return textCell(row.traceId, 190);
        case "nodeKind": return textCell(row.nodeKind, 120);
        case "isFork": return booleanCell(row.isFork);
        case "isCompaction": return booleanCell(row.isCompaction);

        case "route":
          return (
            <div className="min-w-0 max-w-full">
              <span className="block truncate font-mono text-xs text-slate-200" title={row.route || ""}>{row.route || "—"}</span>
              {row.credentialName ? <span className="block truncate text-[11px] text-slate-500" title={row.credentialName}>{row.credentialName}</span> : null}
            </div>
          );
        case "credentialName": return textCell(row.credentialName, 180);
        case "apiGroupLabel": return textCell(row.apiGroupLabel, 140);
        case "endpoint": return textCell(row.endpoint, 210);
        case "authType": return textCell(row.authType, 120);
        case "executorType": return textCell(row.executorType, 130);
        case "accessProvider": return textCell(row.accessProvider, 140);
        case "isNativeKey": return booleanCell(row.isNativeKey);
        case "reasoningEffort": return textCell(row.reasoningEffort, 130);
        case "serviceTier": return textCell(row.serviceTier, 130);
        case "stream": return booleanCell(row.stream);
        case "generate": return booleanCell(row.generate);
        case "modelSubstituted": return booleanCell(row.modelSubstituted);
        case "totalTokens":
          return (
            <div className="min-w-0 tabular-nums" title={"总计 " + formatNumberWithCommas(row.totalTokens) + " · 输入 " + formatNumberWithCommas(row.inputTokens) + " · 输出 " + formatNumberWithCommas(row.outputTokens) + " · 思考 " + formatNumberWithCommas(row.reasoningTokens)}>
              <div className="whitespace-nowrap text-[13px] font-semibold text-slate-100">
                {formatCompactTokens(row.totalTokens)} <span className="text-[10px] font-normal text-slate-500">tokens</span>
              </div>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-slate-400">
                <span className="shrink-0">↑ {formatCompactTokens(row.inputTokens)}</span>
                <span className="shrink-0">↓ {formatCompactTokens(row.outputTokens)}</span>
                {row.reasoningTokens > 0 ? <span className="shrink-0 text-amber-300/80">思 {formatCompactTokens(row.reasoningTokens)}</span> : null}
              </div>
            </div>
          );
        case "inputTokens": return <span style={{ color: TOKEN_COLORS.input }}>{formatNumberWithCommas(row.inputTokens)}</span>;
        case "outputTokens": return <span style={{ color: TOKEN_COLORS.output }}>{formatNumberWithCommas(row.outputTokens)}</span>;
        case "reasoningTokens": return <span style={{ color: TOKEN_COLORS.reasoning }}>{formatNumberWithCommas(row.reasoningTokens)}</span>;
        case "cachedTokens": return <span style={{ color: TOKEN_COLORS.cached }}>{formatNumberWithCommas(row.cachedTokens)}</span>;
        case "cacheSummary":
          return (
            <div className="min-w-0 tabular-nums" title={"缓存读取 " + formatNumberWithCommas(row.cacheReadTokens) + " · 缓存写入 " + formatNumberWithCommas(row.cacheCreationTokens)}>
              <div className="text-[13px] font-medium text-slate-200">{formatCompactTokens(row.cacheReadTokens)}</div>
              <div className="whitespace-nowrap text-[11px] text-slate-500">
                {row.cacheCreationTokens > 0 ? "写 " + formatCompactTokens(row.cacheCreationTokens) : "读取"}
              </div>
            </div>
          );
        case "cacheReadTokens": return <span className="tabular-nums text-violet-300">{formatNumberWithCommas(row.cacheReadTokens)}</span>;
        case "cacheCreationTokens": return <span className="tabular-nums text-fuchsia-300">{formatNumberWithCommas(row.cacheCreationTokens)}</span>;
        case "latencyMs":
          return (
            <div className="min-w-0 tabular-nums">
              <div className="whitespace-nowrap text-[13px] font-semibold text-slate-100">{formatDuration(row.latencyMs)}</div>
              {row.ttftMs !== null ? <div className="whitespace-nowrap text-[11px] text-slate-500">TTFT {formatDuration(row.ttftMs)}</div> : null}
            </div>
          );
        case "ttftMs": return numberCell(row.ttftMs, " ms");
        case "statusCode": return numberCell(row.statusCode);
        case "cost":
          return (
            <div className="min-w-0 tabular-nums">
              {row.cost === null ? (
                <span className="text-xs text-amber-300" title={"定价状态：" + row.pricingStatus}>未定价</span>
              ) : (
                <>
                  <div className="whitespace-nowrap text-[13px] font-medium text-slate-100">{row.costCurrency === "USD" ? formatCost(row.cost) : (row.cost === 0 ? "0" : row.cost.toFixed(5))}</div>
                  {row.costCurrency !== "USD" ? <div className="text-[11px] text-slate-500">{row.costCurrency}</div> : null}
                </>
              )}
            </div>
          );
        default:
          return null;
      }
    },
    [providerTone, statusTone]
  );
  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (appliedModel) parts.push(`模型: ${appliedModel}`);
    if (appliedRoute) parts.push(`密钥: ${appliedRoute}`);
    if (appliedSource) parts.push(`凭证: ${appliedSource}`);
    if (appliedProvider) parts.push(`Provider: ${appliedProvider}`);
    if (appliedServiceTier) parts.push(`Tier: ${appliedServiceTier}`);
    if (appliedStatus) parts.push(`状态: ${appliedStatus === "error" ? "失败" : "成功"}`);
    if (appliedCurrency) parts.push(`币种: ${appliedCurrency}`);
    const advancedCount = Object.values(appliedAdvancedFilters).filter((value) => value.trim()).length;
    if (advancedCount) parts.push(`高级条件: ${advancedCount} 项`);
    if (appliedStart || appliedEnd) {
      const startLabel = appliedStart ? formatDateTimeDisplay(appliedStart) : "-";
      const endLabel = appliedEnd ? formatDateTimeDisplay(appliedEnd) : "-";
      parts.push(`时间: ${startLabel} ~ ${endLabel}`);
    }
    return parts.length ? parts.join(" / ") : "暂无筛选";
  }, [appliedModel, appliedRoute, appliedSource, appliedProvider, appliedServiceTier, appliedStatus, appliedCurrency, appliedAdvancedFilters, appliedStart, appliedEnd]);
  const rangeLabel = useMemo(() => {
    if (!startInput && !endInput) return "选择时间范围";
    const startLabel = startInput ? formatDateTimeDisplay(startInput) : "-";
    const endLabel = endInput ? formatDateTimeDisplay(endInput) : "-";
    return `${startLabel} ~ ${endLabel}`;
  }, [startInput, endInput]);

  const dayPickerLocale = useMemo(() => {
    if (typeof navigator === "undefined") return zhCN;
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) return zhCN;
    if (lang.startsWith("ja")) return ja;
    if (lang.startsWith("ko")) return ko;
    return enUS;
  }, []);

  const dayPickerClassNames = useMemo(
    () => ({
      months: "flex flex-col gap-2",
      month: "relative space-y-2",
      month_caption: "px-2 py-2 pr-18 text-sm text-slate-200",
      caption: "px-2 py-2 pr-18 text-sm text-slate-200",
      caption_label: "relative top-[2px] text-sm font-semibold text-slate-100",
      nav: "absolute right-2 top-2 z-10 flex items-center gap-2",
      button_previous: "h-7 w-7 rounded-md text-slate-300 hover:bg-slate-800/80",
      button_next: "h-7 w-7 rounded-md text-slate-300 hover:bg-slate-800/80",
      month_grid: "w-full border-separate border-spacing-y-2",
      weekdays: "text-xs text-slate-500",
      weekday: "pb-1",
      weeks: "",
      week: "w-full",
      day: "p-0",
      day_button: "h-8 w-full text-sm text-slate-200 hover:!bg-indigo-500 hover:!text-white rounded-none hover:!rounded-md relative z-10 transition-all",
      today: "text-indigo-300 font-semibold",
      selected: "!bg-indigo-500 !text-white font-semibold rounded-none hover:!bg-indigo-600 hover:!text-white",
      range_start: "!bg-indigo-500 !text-white font-semibold !rounded-l-lg hover:!bg-indigo-600 hover:!text-white",
      range_end: "!bg-indigo-500 !text-white font-semibold !rounded-r-lg hover:!bg-indigo-600 hover:!text-white",
      range_middle: "!bg-indigo-500/25 !text-indigo-100 rounded-none hover:!bg-indigo-500/40 hover:!text-white hover:!rounded-none",
      outside: "text-slate-600",
      disabled: "text-slate-600"
    }),
    []
  );

  useEffect(() => {
    if (!rangePickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rangePickerRef.current && !rangePickerRef.current.contains(target)) {
        setRangePickerOpen(false);
        setRangeError(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [rangePickerOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      setColumnSettingsReady(true);
      return;
    }
    try {
      const current = window.localStorage.getItem(COLUMN_SETTINGS_STORAGE_KEY);
      const legacy = window.localStorage.getItem(LEGACY_COLUMN_SETTINGS_STORAGE_KEY) ?? window.localStorage.getItem(OLDER_COLUMN_SETTINGS_STORAGE_KEY);
      const raw = current ?? legacy;
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (current || !isUntouchedLegacyColumnLayout(parsed)) setColumnSettings(normalizeColumnSettings(parsed));
      }
    } catch {
      setColumnSettings(defaultColumnSettings());
    } finally {
      setColumnSettingsReady(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !columnSettingsReady) return;
    window.localStorage.setItem(COLUMN_SETTINGS_STORAGE_KEY, JSON.stringify(columnSettings));
  }, [columnSettings, columnSettingsReady]);

  useEffect(() => {
    if (!columnPanelOpen) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (columnPanelRef.current && !columnPanelRef.current.contains(target)) {
        setColumnPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnPanelOpen]);

  useEffect(() => {
    const element = tableWrapperRef.current;
    if (!element) return;

    const updateWidth = () => {
      setTableContainerWidth(element.clientWidth);
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 px-6 py-8 text-slate-100">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">调用记录</h1>
          <p className="text-base text-slate-400">展示模型调用明细</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
          <button
            onClick={refreshRecords}
            disabled={loading}
            className={"inline-flex items-center gap-2 rounded-lg border px-3 py-2 font-semibold transition " + (loading
              ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500"
              : "border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500")}
          >
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
            {loading ? "刷新中..." : "刷新"}
          </button>
          <button type="button" onClick={() => exportRecords("csv")} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-semibold text-slate-200 hover:border-slate-500">
            <Download className="h-4 w-4" /> CSV
          </button>
          <button type="button" onClick={() => exportRecords("json")} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-semibold text-slate-200 hover:border-slate-500">
            <FileJson className="h-4 w-4" /> JSON
          </button>
        </div>
      </header>

      <section className="mt-4 rounded-2xl bg-slate-800/50 p-4 shadow-sm ring-1 ring-slate-700">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-slate-400" />
            <span>筛选</span>
          </div>

          <ComboBox
            value={modelInput}
            onChange={setModelInput}
            options={models}
            placeholder="按模型过滤"
            darkMode={true}
            onSelectOption={applyModelOption}
            onClear={() => {
              setModelInput("");
              setAppliedModel("");
            }}
          />
          <ComboBox
            value={routeInput}
            onChange={setRouteInput}
            options={routes}
            placeholder="按 Key 过滤"
            darkMode={true}
            onSelectOption={applyRouteOption}
            onClear={() => {
              setRouteInput("");
              setAppliedRoute("");
            }}
          />
          <ComboBox
            value={sourceInput}
            onChange={setSourceInput}
            options={sources}
            placeholder="按凭证过滤"
            darkMode={true}
            onSelectOption={applySourceOption}
            onClear={() => {
              setSourceInput("");
              setAppliedSource("");
            }}
          />

          <input value={providerInput} onChange={(event) => setProviderInput(event.target.value)} placeholder="Provider" className="w-28 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200" />
          <input value={serviceTierInput} onChange={(event) => setServiceTierInput(event.target.value)} placeholder="Service Tier" className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200" />
          <select value={statusInput} onChange={(event) => setStatusInput(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"><option value="">全部状态</option><option value="success">成功</option><option value="error">失败</option></select>
          <input value={currencyInput} onChange={(event) => setCurrencyInput(event.target.value)} placeholder="币种" className="w-20 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200" />
          <input value={advancedFilters.q} onChange={(event) => updateAdvancedFilter("q", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} placeholder="搜索 Request ID / Model / Endpoint" className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600" />
          <button type="button" onClick={() => setAdvancedFiltersOpen((previous) => !previous)} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${advancedFiltersOpen ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200" : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500"}`}>
            <Search className="h-4 w-4" /> 高级筛选
          </button>
          <div className="relative" ref={rangePickerRef}>
            <button
              type="button"
              onClick={() => {
                const start = parseDateTimeInput(startInput);
                const end = parseDateTimeInput(endInput);
                if (start && end) {
                  setRange({ from: start.date, to: end.date });
                  setTimeStart(start.time ?? "00:00");
                  setTimeEnd(end.time ?? "23:59");
                } else if (start) {
                  setRange({ from: start.date, to: start.date });
                  setTimeStart(start.time ?? "00:00");
                } else if (end) {
                  setRange({ from: end.date, to: end.date });
                  setTimeEnd(end.time ?? "23:59");
                } else {
                  setRange(undefined);
                  setTimeStart("00:00");
                  setTimeEnd("23:59");
                }
                setRangeError(null);
                setRangePickerOpen((prev) => !prev);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-500"
            >
              <CalendarRange className="h-4 w-4 text-indigo-400" />
              <span className="whitespace-nowrap">{rangeLabel}</span>
            </button>

            {rangePickerOpen ? (
              <div className="absolute left-0 z-20 mt-2 min-w-[320px] w-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-lg">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                  <DayPicker
                    mode="range"
                    selected={range}
                    onSelect={setRange}
                    numberOfMonths={1}
                    locale={dayPickerLocale}
                    className="rdp rdp-dark text-slate-200"
                    classNames={dayPickerClassNames}
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="block text-xs text-slate-400">
                    开始时间
                    <input
                      type="time"
                      value={timeStart}
                      onChange={(e) => setTimeStart(e.target.value)}
                      className="mt-1 w-auto min-w-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    结束时间
                    <input
                      type="time"
                      value={timeEnd}
                      onChange={(e) => setTimeEnd(e.target.value)}
                      className="mt-1 w-auto min-w-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                </div>
                {rangeError ? <p className="text-xs text-red-400">{rangeError}</p> : null}
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRangePickerOpen(false);
                      setRangeError(null);
                    }}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!range?.from || !range?.to) {
                        setRangeError("请选择开始和结束时间");
                        return;
                      }
                      if (range.to < range.from) {
                        setRangeError("结束时间需不早于开始时间");
                        return;
                      }
                      if (!/^\d{2}:\d{2}$/.test(timeStart) || !/^\d{2}:\d{2}$/.test(timeEnd)) {
                        setRangeError("时间格式无效");
                        return;
                      }
                      setRangeError(null);
                      const startValue = `${formatDateInput(range.from)}T${timeStart}`;
                      const endValue = `${formatDateInput(range.to)}T${timeEnd}`;
                      setStartInput(startValue);
                      setEndInput(endValue);
                      applyFilters({ start: startValue, end: endValue });
                      setRangePickerOpen(false);
                    }}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    应用
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <button type="button" onClick={() => applyFilters()} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500">应用筛选</button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setModelInput("");
                setRouteInput("");
                setSourceInput("");
                setProviderInput("");
                setServiceTierInput("");
                setStatusInput("");
                setCurrencyInput("");
                setAdvancedFilters({ ...EMPTY_ADVANCED_FILTERS });
                setAppliedAdvancedFilters({ ...EMPTY_ADVANCED_FILTERS });
                setStartInput("");
                setEndInput("");
                setAppliedModel("");
                setAppliedRoute("");
                setAppliedSource("");
                setAppliedProvider("");
                setAppliedServiceTier("");
                setAppliedStatus("");
                setAppliedCurrency("");
                setAppliedStart("");
                setAppliedEnd("");
                setRange(undefined);
                setRangePickerOpen(false);
                setRangeError(null);
                setTimeStart("00:00");
                setTimeEnd("23:59");
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-1.5 text-sm font-semibold text-slate-300 hover:border-slate-500"
            >
              重置
            </button>
          </div>

          <div className="ml-auto relative" ref={columnPanelRef}>
            <button
              type="button"
              onClick={() => setColumnPanelOpen((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-500"
            >
              <Columns3 className="h-4 w-4 text-indigo-400" />
              <span>列选择</span>
            </button>

            {columnPanelOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-[300px] rounded-2xl border border-slate-700 bg-slate-900 p-3 shadow-xl">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span>显示字段 · 拖拽排序</span>
                  <button
                    type="button"
                    data-testid="records-reset-columns"
                    onClick={() => { setColumnSettings(defaultColumnSettings()); setColumnPanelOpen(false); }}
                    className="rounded-md px-2 py-1 text-indigo-300 hover:bg-slate-800 hover:text-indigo-200"
                  >
                    恢复简洁布局
                  </button>
                </div>
                <div className="max-h-72 space-y-1 overflow-auto pr-1">
                  {columnSettings.map((column) => (
                    <div
                      key={column.key}
                      draggable
                      onDragStart={() => onColumnDragStart(column.key)}
                      onDragOver={(event) => onColumnDragOver(column.key, event)}
                      onDrop={(event) => onColumnDrop(column.key, event)}
                      onDragEnd={onColumnDragEnd}
                      className="relative flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5"
                    >
                      {dragIndicator?.key === column.key && dragIndicator.position === "before" ? (
                        <span className="pointer-events-none absolute left-2 right-2 top-0 h-px -translate-y-1/2 bg-indigo-300/90 shadow-[0_0_6px_rgba(129,140,248,0.45)]" />
                      ) : null}
                      {dragIndicator?.key === column.key && dragIndicator.position === "after" ? (
                        <span className="pointer-events-none absolute left-2 right-2 bottom-0 h-px translate-y-1/2 bg-indigo-300/90 shadow-[0_0_6px_rgba(129,140,248,0.45)]" />
                      ) : null}
                      <label className="inline-flex items-center gap-2 text-sm text-slate-200">
                        <span className="cursor-grab text-slate-500 active:cursor-grabbing" title="按住拖拽排序">
                          <GripVertical className="h-4 w-4" />
                        </span>
                        <input
                          type="checkbox"
                          checked={column.visible}
                          onChange={() => toggleColumnVisibility(column.key)}
                          disabled={column.visible && visibleColumnCount === 1}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                        />
                        <span>{COLUMN_LABELS[column.key]}</span>
                        <span className="text-xs text-slate-500">{column.width ? `${column.width}px` : "auto"}</span>
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {advancedFiltersOpen ? (
          <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
            {([
              ["requestId", "Request ID"],
              ["apiGroupLabel", "API Group"],
              ["endpoint", "Endpoint"],
              ["authType", "Auth Type"],
              ["executorType", "Executor"],
              ["reasoningEffort", "Reasoning Effort"],
              ["modelAlias", "Model Alias"],
              ["responseModel", "Response Model"],
              ["statusCode", "HTTP Status"],
              ["latencyMin", "最小延迟（ms）"],
              ["latencyMax", "最大延迟（ms）"],
              ["tokensMin", "最小 Tokens"],
              ["tokensMax", "最大 Tokens"]
            ] as Array<[Exclude<keyof AdvancedFilters, "q" | "costStatus">, string]>).map(([key, label]) => (
              <label key={key} className="block text-xs text-slate-400">
                {label}
                <input
                  value={advancedFilters[key]}
                  onChange={(event) => updateAdvancedFilter(key, event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }}
                  placeholder={label}
                  inputMode={key === "statusCode" || key.includes("Min") || key.includes("Max") ? "numeric" : "text"}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
                />
              </label>
            ))}
            <label className="block text-xs text-slate-400">
              费用状态
              <select
                value={advancedFilters.costStatus}
                onChange={(event) => updateAdvancedFilter("costStatus", event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
              >
                <option value="">全部</option>
                <option value="priced">已定价</option>
                <option value="unpriced">未定价 / 定价异常</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button type="button" onClick={() => applyFilters()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">应用高级筛选</button>
              <button type="button" onClick={() => { setAdvancedFilters({ ...EMPTY_ADVANCED_FILTERS }); setAppliedAdvancedFilters({ ...EMPTY_ADVANCED_FILTERS }); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500">清空高级条件</button>
            </div>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-slate-500">当前筛选：{filterSummary}</p>
      </section>

      <section className={"mt-5 rounded-2xl border border-slate-700/70 bg-slate-900/60 p-3 shadow-sm md:p-4 " + (loadingEmpty && !hasLoaded ? "min-h-[100vh]" : "")}>
        {(!loadingEmpty || hasLoaded) ? (
          <>
            <div ref={tableWrapperRef} data-testid="records-table-scroll" className="hidden overflow-x-auto rounded-xl lg:block">
              <table data-testid="records-events-table" className="w-full min-w-full table-fixed border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-900/95">
                  <tr className="border-b border-slate-700/60 text-[11px] font-medium tracking-wide text-slate-400">
                    {visibleColumns.map((columnKey) => {
                      const width = adaptiveWidthMap.get(columnKey) ?? DEFAULT_COLUMN_WIDTHS[columnKey];
                      return (
                        <th
                          key={columnKey}
                          className={"group/col relative whitespace-nowrap px-3 py-3 font-medium " + (RIGHT_ALIGNED_COLUMNS.has(columnKey) ? "text-right" : "text-left")}
                          style={{ width: width + "px", minWidth: width + "px" }}
                        >
                          {renderHeaderByColumn(columnKey)}
                          <div
                            role="separator"
                            aria-orientation="vertical"
                            onMouseDown={(event) => beginResizeColumn(columnKey, event)}
                            className="pointer-events-none absolute right-0 top-0 h-full w-2 cursor-col-resize select-none opacity-0 transition-opacity group-hover/col:pointer-events-auto group-hover/col:opacity-100"
                            title="拖拽调整列宽"
                          >
                            <span className="absolute right-[2px] top-2 bottom-2 w-px bg-indigo-300/50" />
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="text-[13px]">
                  {records.map((row) => (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      aria-label={"查看请求详情：" + (row.requestId || row.id)}
                      aria-expanded={selectedRecord?.id === row.id}
                      onClick={() => setSelectedRecord({ id: row.id, occurredAt: row.occurredAt })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedRecord({ id: row.id, occurredAt: row.occurredAt });
                        }
                      }}
                      className={"group h-[68px] cursor-pointer text-slate-100 transition-colors even:bg-slate-800/20 hover:bg-slate-800/70 focus:outline-none focus-visible:bg-indigo-500/15 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 " + (selectedRecord?.id === row.id ? "bg-indigo-500/10" : "")}
                    >
                      {visibleColumns.map((columnKey, index) => {
                        const width = adaptiveWidthMap.get(columnKey) ?? DEFAULT_COLUMN_WIDTHS[columnKey];
                        const isLast = index === visibleColumns.length - 1;
                        return (
                          <td
                            key={row.id + "-" + columnKey}
                            className={"relative min-w-0 overflow-hidden whitespace-nowrap px-3 py-3 align-middle " + (RIGHT_ALIGNED_COLUMNS.has(columnKey) ? "text-right" : "text-left") + (isLast ? " pr-7" : "")}
                            style={{ width: width + "px", minWidth: width + "px" }}
                          >
                            {renderCellByColumn(columnKey, row)}
                            {isLast ? (
                              <ChevronRight aria-hidden="true" className="pointer-events-none absolute right-1 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600 transition-colors group-hover:text-indigo-300" />
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {loading && records.length === 0 && hasLoaded
                    ? Array.from({ length: 12 }, (_, i) => (
                      <tr key={"skel-" + i} className="h-[68px]">
                        {visibleColumns.map((columnKey) => (
                          <td key={columnKey} className="px-3 py-3">
                            <div className="h-3 w-4/5 animate-pulse rounded bg-slate-700/60" />
                          </td>
                        ))}
                      </tr>
                    ))
                    : null}
                </tbody>
              </table>
            </div>
            <div data-testid="records-mobile-list" className="space-y-2 lg:hidden">
              {records.map((row) => (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => setSelectedRecord({ id: row.id, occurredAt: row.occurredAt })}
                  aria-label={"查看请求详情：" + (row.requestId || row.id)}
                  className="block w-full rounded-xl border border-slate-700/60 bg-slate-800/40 p-3 text-left transition hover:border-indigo-400/50 hover:bg-slate-800/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-100" title={row.model}>{row.model}</span>
                        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-400">
                        {row.provider || "—"} <span className="mx-1 text-slate-600">·</span> {formatTimestamp(row.occurredAt)}
                      </div>
                    </div>
                    <span className={"shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium " + statusTone(row.isError)}>
                      {row.isError ? "失败" : "成功"}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-3 border-t border-slate-700/50 pt-3">
                    <div className="min-w-0">
                      <div className="text-[11px] text-slate-500">耗时</div>
                      <div className="mt-1 truncate text-xs font-medium tabular-nums text-slate-200">{formatDuration(row.latencyMs)}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] text-slate-500">Tokens</div>
                      <div className="mt-1 truncate text-xs font-medium tabular-nums text-slate-200">{formatCompactTokens(row.totalTokens)}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] text-slate-500">费用</div>
                      <div className="mt-1 truncate text-xs font-medium tabular-nums text-slate-200">{row.cost === null ? "未定价" : row.costCurrency === "USD" ? formatCost(row.cost) : `${row.cost.toFixed(5)} ${row.costCurrency}`}</div>
                    </div>
                  </div>
                  <div className="mt-2 truncate font-mono text-[11px] text-slate-500" title={row.route}>{row.route}</div>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {loadingEmpty && !hasLoaded ? (
          <div className="mt-4 grid min-h-[55vh] gap-3">
            {[1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : null}

        {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}

        {isEmpty ? <p className="mt-4 text-sm text-slate-400">暂无记录</p> : null}

        {(records.length > 0 || (hasLoaded && loading)) ? (
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <span>已加载 {records.length} 条</span>
            {loading ? <span>加载中...</span> : hasMore ? <span>继续向下滚动加载</span> : <span>已到底</span>}
          </div>
        ) : null}

        <div ref={sentinelRef} className="h-6" />
      </section>

      {refreshStatus && (
        <div
          role="status"
          aria-live="polite"
          data-testid="records-refresh-status"
          onClick={() => closeRefreshStatus()}
          className={`fixed right-6 top-26 z-50 max-w-[290px] cursor-pointer rounded-lg border border-green-500/40 bg-green-900/80 px-4 py-3 text-green-100 shadow-lg transition-opacity hover:opacity-90 ${
            refreshStatusClosing ? "animate-toast-out" : "animate-toast-in"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl animate-emoji-pop">✅</span>
            <span className="text-sm font-medium">{refreshStatus}</span>
          </div>
        </div>
      )}

      {selectedRecord ? (
        <RecordDetailsDrawer
          eventId={selectedRecord.id}
          occurredAt={selectedRecord.occurredAt}
          onClose={() => setSelectedRecord(null)}
        />
      ) : null}
    </main>
  );
}

function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  darkMode,
  className,
  onSelectOption,
  onClear
}: {
  value: string;
  onChange: (val: string) => void;
  options: string[];
  placeholder?: string;
  darkMode: boolean;
  className?: string;
  onSelectOption?: (val: string) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [hasTyped, setHasTyped] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    if (!hasTyped) return options;
    return options.filter((opt) => opt.toLowerCase().includes(value.toLowerCase()));
  }, [hasTyped, options, value]);

  const baseInput = `${className ?? ""} rounded-lg border px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none ${
    darkMode ? "border-slate-700 bg-slate-800 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"
  }`;

  const closeDropdown = () => {
    setIsClosing(true);
    setTimeout(() => {
      setOpen(false);
      setIsVisible(false);
      setIsClosing(false);
    }, 100);
  };

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        startTransition(() => {
          setIsVisible(true);
          setIsClosing(false);
        });
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setHasTyped(true);
          onChange(e.target.value);
        }}
        onFocus={() => {
          setOpen(true);
          setHasTyped(false);
        }}
        placeholder={placeholder}
        className={`${baseInput} pr-8`}
      />
      {value && (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            onChange("");
            setHasTyped(false);
            onClear?.();
          }}
          className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition ${
            darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-slate-200" : "text-slate-500 hover:bg-slate-200 hover:text-slate-700"
          }`}
          title="清除"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {isVisible && filtered.length > 0 ? (
        <div
          className={`absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-xl border shadow-lg scrollbar-slim ${
            darkMode ? "border-slate-600/60 bg-slate-900/70 backdrop-blur-sm" : "border-slate-200/80 bg-white/80 backdrop-blur-sm"
          } ${isClosing ? "animate-dropdown-out" : "animate-dropdown-in"}`}
        >
          {filtered.map((opt) => (
            <button
              type="button"
              key={opt}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt);
                setHasTyped(false);
                closeDropdown();
                inputRef.current?.blur();
                onSelectOption?.(opt);
              }}
              className={`flex w-full items-start justify-between px-3 py-2 text-left text-sm transition ${
                darkMode ? "text-slate-200 hover:bg-slate-800" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <span className="whitespace-normal break-words text-left">{opt}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}