import { expect, test } from "@playwright/test";

const password = process.env.PASSWORD || "";

async function login(page: import("@playwright/test").Page) {
  if (!password) throw new Error("PASSWORD is required for dashboard browser acceptance");
  await page.goto("/login");
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("unauthenticated dashboard redirects to the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByPlaceholder("输入访问密码")).toBeVisible();
  const workerAsset = await page.evaluate(async () => {
    const response = await fetch("/auto-refresh-worker.js", { cache: "no-store" });
    return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
  });
  expect(workerAsset.status).toBe(200);
  expect(workerAsset.contentType || "").toMatch(/javascript/);
  expect(workerAsset.body).toContain("postMessage");
  await expect(page.getByRole("link", { name: "CLIProxyAPI Monitor" })).toHaveAttribute(
    "href",
    "https://github.com/ITSGJY/CLIProxyAPI-Monitor"
  );
});

test("login and all dashboard pages render with JSON API responses", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const apiFailures: Array<{ url: string; status: number; contentType: string; body: string }> = [];
  const apiTasks: Promise<void>[] = [];
  const overviewRequests: string[] = [];
  const recordsRequests: string[] = [];
  const syncRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${page.url()} :: ${error.stack || error.message}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/overview") overviewRequests.push(request.url());
    if (url.pathname === "/api/records") recordsRequests.push(request.url());
    if (url.pathname === "/api/sync") syncRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${page.url()} :: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText || "unknown";
    if (errorText !== "net::ERR_ABORTED") requestFailures.push(`${request.method()} ${request.url()} :: ${errorText}`);
  });
  page.on("response", (response) => {
    if (!response.url().includes("/api/")) return;
    const contentType = response.headers()["content-type"] || "";
    if (response.status() >= 400 || !contentType.includes("application/json")) {
      apiTasks.push((async () => {
        const body = await response.text().catch(() => "<body unavailable>");
        apiFailures.push({ url: response.url(), status: response.status(), contentType, body: body.slice(0, 500) });
      })());
    }
  });

  await page.route("**/api/management-url", (route) => route.fulfill({ status: 200, json: { url: "http://127.0.0.1:8317/management.html" } }));
  await page.route("**/api/usage-statistics-enabled", (route) => route.fulfill({ status: 200, json: { "usage-statistics-enabled": false } }));

  await login(page);
  await expect(page.getByRole("heading", { name: "Usage Dashboard" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator('a[href="https://github.com/ITSGJY/CLIProxyAPI-Monitor"]')).toHaveCount(1);
  await expect(page.getByText("价格覆盖率", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Pricing Center · 模型价格体系" })).toHaveCount(0);
  await expect.poll(() => overviewRequests.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "刷新数据" })).toBeEnabled();
  const manualRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("skipCache") === "1";
  });
  await page.getByRole("button", { name: "刷新数据" }).click();
  expect((await manualRefresh).status()).toBe(200);

  const allTimeRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("all") === "1";
  });
  await page.getByRole("button", { name: "时间范围：全部" }).click();
  const allTimeResponse = await allTimeRefresh;
  expect(allTimeResponse.status()).toBe(200);
  expect(new URL(allTimeResponse.url()).searchParams.has("days")).toBe(false);

  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "数据探索" })).toBeVisible();

  const firstRecordsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && url.searchParams.get("includeFilters") === "1" && url.searchParams.get("includeTotal") === "1";
  });
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "调用记录" })).toBeVisible();
  const initialRecordsResponse = await firstRecordsResponse;
  expect(initialRecordsResponse.status()).toBe(200);
  expect(typeof (await initialRecordsResponse.json()).totalCount).toBe("number");

  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  const recordsRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && url.searchParams.get("includeTotal") === "1" && url.searchParams.get("refresh") === "1" && !url.searchParams.has("includeFilters") && !url.searchParams.has("cursor");
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const refreshedRecordsResponse = await recordsRefresh;
  expect(refreshedRecordsResponse.status()).toBe(200);
  expect(typeof (await refreshedRecordsResponse.json()).totalCount).toBe("number");
  await expect(page.getByTestId("records-refresh-status")).toContainText(/新增 \d+ 条记录|暂无新增数据|当前筛选共 \d+ 条记录/);  await expect(page.getByTestId("records-refresh-status")).not.toContainText("刷新完成");
  expect(recordsRequests.length).toBeGreaterThanOrEqual(2);
  expect(syncRequests).toEqual([]);
  await Promise.all(apiTasks);
  expect({ pageErrors, consoleErrors, requestFailures, apiFailures }).toEqual({
    pageErrors: [], consoleErrors: [], requestFailures: [], apiFailures: []
  });
});

test("dashboard manual and automatic refreshes show transient toast counts", async ({ page }) => {
  let manualRefreshCount = 0;
  let automaticRefreshCount = 0;
  await page.route("**/api/overview?*", (route) => {
    const url = new URL(route.request().url());
    const refreshSource = url.searchParams.get("refreshSource");
    const totalRequests = refreshSource === "manual"
      ? (manualRefreshCount++ === 0 ? 103 : 105)
      : refreshSource === "auto"
        ? (automaticRefreshCount++ === 0 ? 108 : 108)
        : 100;
    return route.fulfill({
      status: 200,
      json: {
        overview: {
          totalRequests,
          totalTokens: totalRequests * 10,
          totalInputTokens: totalRequests * 6,
          totalOutputTokens: totalRequests * 4,
          totalReasoningTokens: 0,
          totalCachedTokens: 0,
          successCount: totalRequests,
          failureCount: 0,
          successRate: 1,
          totalCost: null,
          models: [],
          byDay: [],
          byHour: []
        },
        empty: false,
        days: 14,
        timezone: "Asia/Shanghai",
        lastSyncAt: null,
        meta: { page: 1, pageSize: 500, totalModels: 0, totalPages: 1 },
        filters: { models: [], routes: [], names: [], providers: [], serviceTiers: [] },
        costByCurrency: [],
        pricingCoverage: { priced: 0, unpriced: 0, partial: 0, rate: 1 }
      }
    });
  });
  await page.route("**/api/prices", (route) => route.fulfill({ status: 200, json: [] }));
  await page.route("**/api/management-url", (route) => route.fulfill({ status: 200, json: { url: "http://127.0.0.1:8317/management.html" } }));
  await page.route("**/api/usage-statistics-enabled", (route) => route.fulfill({ status: 200, json: { "usage-statistics-enabled": false } }));

  const initialOverview = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && !url.searchParams.has("refreshSource");
  });
  await login(page);
  expect((await initialOverview).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Usage Dashboard" })).toBeVisible();
  await expect.poll(() => page.workers().some((worker) => new URL(worker.url()).pathname === "/auto-refresh-worker.js")).toBe(true);
  await expect(page.getByRole("button", { name: "刷新数据" })).toBeEnabled();

  const manualRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("refreshSource") === "manual";
  });
  await page.getByRole("button", { name: "刷新数据" }).click();
  expect((await manualRefresh).status()).toBe(200);
  await expect(page.getByTestId("dashboard-refresh-status")).toContainText("新增 3 条请求");
  await expect(page.getByTestId("dashboard-refresh-status")).toHaveClass(/top-26/);
  await expect(page.getByTestId("dashboard-refresh-status")).not.toContainText("刷新完成");
  await expect(page.getByTestId("dashboard-refresh-summary")).toHaveCount(0);

  await page.getByTestId("auto-refresh-interval").selectOption("custom");
  await page.getByTestId("auto-refresh-custom-interval").fill("5");

  const immediateAutoRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("refreshSource") === "auto";
  });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  expect((await immediateAutoRefresh).status()).toBe(200);
  await expect(page.getByTestId("dashboard-refresh-status")).toContainText("新增 5 条请求");

  const periodicAutoRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("refreshSource") === "auto";
  }, { timeout: 12000 });
  expect((await periodicAutoRefresh).status()).toBe(200);
  expect(automaticRefreshCount).toBe(2);
  await expect(page.getByTestId("dashboard-refresh-status")).toContainText("暂无新增数据");

  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  await page.waitForTimeout(5500);
  expect(automaticRefreshCount).toBe(2);

  await expect(page.getByRole("button", { name: "刷新数据" })).toBeEnabled();
  const noNewDataRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("refreshSource") === "manual";
  });
  await page.getByRole("button", { name: "刷新数据" }).click();
  expect((await noNewDataRefresh).status()).toBe(200);
  await expect(page.getByTestId("dashboard-refresh-status")).toContainText("暂无新增数据");
  await expect(page.getByTestId("dashboard-refresh-status")).toBeHidden({ timeout: 12000 });
});
test("records page follows the dashboard auto-refresh state and interval", async ({ page }) => {
  let dashboardAutoRefreshCount = 0;
  let recordsAutoRefreshCount = 0;
  const syncRequests: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sync") syncRequests.push(request.url());
  });

  await page.route("**/api/overview?*", (route) => {
    const url = new URL(route.request().url());
    const isAutoRefresh = url.searchParams.get("refreshSource") === "auto";
    if (isAutoRefresh) dashboardAutoRefreshCount += 1;
    const totalRequests = isAutoRefresh ? 108 : 100;
    return route.fulfill({
      status: 200,
      json: {
        overview: {
          totalRequests,
          totalTokens: totalRequests * 10,
          totalInputTokens: totalRequests * 6,
          totalOutputTokens: totalRequests * 4,
          totalReasoningTokens: 0,
          totalCachedTokens: 0,
          successCount: totalRequests,
          failureCount: 0,
          successRate: 1,
          totalCost: null,
          models: [],
          byDay: [],
          byHour: []
        },
        empty: false,
        days: 14,
        timezone: "Asia/Shanghai",
        lastSyncAt: null,
        meta: { page: 1, pageSize: 500, totalModels: 0, totalPages: 1 },
        filters: { models: [], routes: [], names: [], providers: [], serviceTiers: [] },
        costByCurrency: [],
        pricingCoverage: { priced: 0, unpriced: 0, partial: 0, rate: 1 }
      }
    });
  });
  await page.route("**/api/records?*", (route) => {
    const url = new URL(route.request().url());
    const isRefresh = url.searchParams.get("refresh") === "1";
    if (isRefresh) recordsAutoRefreshCount += 1;
    return route.fulfill({
      status: 200,
      json: {
        items: [],
        nextCursor: null,
        totalCount: isRefresh ? 105 : 100,
        filters: { models: [], routes: [], sources: [], providers: [], serviceTiers: [] }
      }
    });
  });
  await page.route("**/api/prices", (route) => route.fulfill({ status: 200, json: [] }));
  await page.route("**/api/management-url", (route) => route.fulfill({ status: 200, json: { url: "http://127.0.0.1:8317/management.html" } }));
  await page.route("**/api/usage-statistics-enabled", (route) => route.fulfill({ status: 200, json: { "usage-statistics-enabled": false } }));

  const initialOverview = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && !url.searchParams.has("refreshSource");
  });
  await login(page);
  expect((await initialOverview).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Usage Dashboard" })).toBeVisible();

  await page.getByTestId("auto-refresh-interval").selectOption("custom");
  await page.getByTestId("auto-refresh-custom-interval").fill("5");
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("autoRefreshSettings") || "{}");
    return saved.custom;
  })).toBe("5");

  const dashboardImmediateRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/overview" && url.searchParams.get("refreshSource") === "auto";
  });
  await page.getByRole("button", { name: "自动刷新", exact: true }).click();
  expect((await dashboardImmediateRefresh).status()).toBe(200);
  expect(dashboardAutoRefreshCount).toBe(1);

  const initialRecords = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && !url.searchParams.has("refresh");
  });
  const immediateRecordsRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && url.searchParams.get("refresh") === "1";
  });
  await page.getByRole("link", { name: "调用记录" }).click();
  expect((await initialRecords).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "调用记录" })).toBeVisible();
  expect((await immediateRecordsRefresh).status()).toBe(200);
  await expect(page.getByTestId("records-refresh-status")).toContainText("新增 5 条记录");
  await expect(page.getByRole("button", { name: "自动刷新" })).toHaveCount(0);
  await expect(page.getByTestId("auto-refresh-interval")).toHaveCount(0);

  const periodicRecordsRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && url.searchParams.get("refresh") === "1";
  }, { timeout: 12000 });
  expect((await periodicRecordsRefresh).status()).toBe(200);
  expect(recordsAutoRefreshCount).toBe(2);
  await expect(page.getByTestId("records-refresh-status")).toContainText("暂无新增数据");

  await page.getByRole("link", { name: "仪表盘" }).click();
  await expect(page.getByRole("heading", { name: "Usage Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "自动刷新" }).click();

  const recordsAfterDisable = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && !url.searchParams.has("refresh");
  });
  await page.getByRole("link", { name: "调用记录" }).click();
  expect((await recordsAfterDisable).status()).toBe(200);
  await page.waitForTimeout(5500);
  expect(recordsAutoRefreshCount).toBe(2);
  expect(syncRequests).toEqual([]);
});

test("records page exposes configurable event columns, request details and filtered exports", async ({ page }) => {
  const occurredAt = "2026-11-19T06:00:00.000Z";
  const summary = {
    id: 101,
    occurredAt,
    route: "****1234",
    source: "auth-file.json",
    credentialName: "primary-account",
    provider: "OpenAI",
    apiGroupLabel: "API Key",
    endpoint: "/v1/responses",
    requestId: "req-e2e-001",
    sessionId: "session-e2e-001",
    parentSessionId: "session-parent-e2e-001",
    executionId: "execution-e2e-001",
    traceId: "trace-e2e-001",
    nodeKind: "message",
    isFork: false,
    isCompaction: false,
    authType: "oauth",
    stream: true,
    generate: true,
    model: "gpt-6",
    modelAlias: "gpt-6",
    responseModel: "gpt-6",
    modelSubstituted: false,
    reasoningEffort: "high",
    executorType: "codex",
    accessProvider: "openai",
    isNativeKey: false,
    totalTokens: 1500,
    inputTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 120,
    cachedTokens: 400,
    cacheReadTokens: 400,
    cacheCreationTokens: 20,
    latencyMs: 2400,
    ttftMs: 500,
    serviceTier: "priority",
    statusCode: 200,
    failCode: null,
    isError: false,
    cost: 0.0012,
    costNanos: 1200000,
    costCurrency: "USD",
    pricingStatus: "priced",
    accountingStatus: "complete"
  };
  const detail = {
    ...summary,
    credentialErrors: {
      attribution: "credential_time_window", window_ms: 120000, limit: 20,
      coverage: { status: "partial", complete: false, window_closed: false, gaps: [{ from: occurredAt, to: "2026-11-19T06:00:01Z" }], reason: "window_not_fully_observed" },
      events: [{ id: "error-1", occurred_at: occurredAt, received_at: occurredAt, provider: "OpenAI", model: "gpt-6", status_code: 429,
        code: "quota", body: '<script>window.phase55Unsafe = true</script>', retryable: true, auth_status: { status: "error" },
        time_delta_ms: -1000, provider_match: true, model_match: true, attribution: "credential_time_window", origin_system: "cpa" }]
    },
    ingestedAt: "2026-11-19T06:00:02.000Z",
    sourceInstanceId: "e2e-instance",
    originSystem: "cpa_live",
    sourceTransport: "resp",
    sourceNativeId: "cpa-event-101",
    sourceEventKey: "source-event-101",
    apiGroupKey: "api_key",
    apiKeyMask: "****1234",
    clientIp: "127.0.0.1",
    xForwardedFor: null,
    userAgent: "e2e-agent",
    sessionId: "session-e2e-001",
    parentSessionId: null,
    executionId: "execution-e2e-001",
    traceId: "trace-e2e-001",
    nodeKind: "message",
    isFork: false,
    isCompaction: false,
    responseServiceTier: "priority",
    effectiveServiceTier: "priority",
    billedServiceTier: "priority",
    billedServiceTierSource: "response",
    failBody: null,
    responseHeaders: [{ name: "x-request-id", value: "req-e2e-001" }],
    tokenAccounting: { status: "complete", token_breakdown: { input: 1000, output: 500 } },
    structuredUsage: { input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 120 } },
    rawPayload: { request_id: "req-e2e-001", api_key: "****1234", authorization: "[redacted]" },
    priceVersionId: 7,
    sourcePriceVersionId: "source-price-7",
    channelVersionId: 3,
    priceTierIndex: 0,
    resolvedServiceTier: "priority",
    pricingPolicyVersion: 1,
    accountingStatus: "complete",
    resourceId: "resource-e2e-001",
    resourceName: "E2E Resource",
    costBreakdown: {
      policy_version: 1,
      buckets: [
        { kind: "input", tokens: "600", rate_per_1m: "2" },
        { kind: "cache_read", tokens: "400", rate_per_1m: "1" },
        { kind: "output", tokens: "500", rate_per_1m: "8" }
      ],
      model_multiplier: "1.2",
      channel_multiplier: "1",
      selected_tier_index: 0,
      selected_tier: { service_tiers: ["priority"] },
      total_cost_nanos: "1200000"
    },
    createdAt: "2026-11-19T06:00:02.000Z"
  };

  const recordListQueries: URL[] = [];

  let recordsRefreshCount = 0;
  await page.route("**/api/records?*", (route) => {
    const query = new URL(route.request().url());
    recordListQueries.push(query);
    const totalCount = query.searchParams.get("refresh") === "1" ? (recordsRefreshCount++ === 0 ? 13 : 10) : 10;
    return route.fulfill({
      status: 200,
      json: {
        items: [summary],
        nextCursor: null,
        totalCount,
        filters: { models: ["gpt-6"], routes: ["****1234"], sources: ["primary-account"], providers: ["OpenAI"], serviceTiers: ["priority"] }
      }
    });
  });
  await page.route("**/api/records/detail?*", (route) => route.fulfill({ status: 200, json: { item: detail } }));
  await page.route("**/api/records/request-log?*", (route) => route.fulfill({
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="request-req-e2e-001.log"'
    },
    body: "request_id=req-e2e-001\\nmodel=gpt-6\\n"
  }));
  await page.route("**/api/records/export?*", (route) => route.fulfill({
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="monitor-records-e2e.csv"'
    },
    body: "request_id,model\r\nreq-e2e-001,gpt-6\r\n"
  }));

  await page.addInitScript(() => {
    const previousCompactColumns = ["occurredAt", "isError", "provider", "model", "requestMode", "latencyMs", "totalTokens", "cost", "cacheSummary", "route"];
    localStorage.setItem("records-column-settings-v4", JSON.stringify(previousCompactColumns.map((key) => ({ key, visible: true, width: null }))));
  });
  await login(page);
  await page.goto("/records");

  await expect(page.getByTestId("records-events-table")).toBeVisible();
  const defaultHeaders = page.getByTestId("records-events-table").locator("thead th");
  await expect(defaultHeaders).toHaveCount(12);
  await expect(defaultHeaders).toHaveText(["请求时间", "结果", "提供商", "模型", "模式", "TPS", "耗时", "消耗", "费用", "缓存率", "Key", "详情"]);
  await expect(page.getByRole("columnheader", { name: "模式" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "TPS" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "缓存率" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "详情" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Request ID/ })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /Cache Write/ })).toHaveCount(0);
  const recordRow = page.getByRole("row", { name: "查看请求详情：req-e2e-001" });
  await expect(recordRow).toContainText("1.5K");
  await expect(recordRow).toContainText("req-e2e-001");
  await expect(recordRow).toContainText("TTFT 500 ms");
  await expect(recordRow).toContainText("primary-account");
  await expect(recordRow).toContainText("OAuth");
  await expect(recordRow).toContainText("high");
  await expect(recordRow).toContainText("208.33 t/s");
  await expect(recordRow).toContainText("40.0%");
  await expect(recordRow).toContainText("****1234");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("records-column-settings-v5") !== null)).toBe(true);
  const migratedWidths = await page.evaluate(() => {
    const columns = JSON.parse(localStorage.getItem("records-column-settings-v5") || "[]");
    return Object.fromEntries(columns.map((column: { key: string; width: number | null }) => [column.key, column.width]));
  });
  expect(migratedWidths.provider).toBeNull();
  expect(migratedWidths.model).toBeNull();
  expect(migratedWidths.details).toBe(44);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();

  const refreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && url.searchParams.get("includeTotal") === "1" && url.searchParams.get("refresh") === "1";
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  expect((await refreshResponse).status()).toBe(200);
  await expect(page.getByTestId("records-refresh-status")).toContainText("新增 3 条记录");
  await expect(page.getByTestId("records-refresh-status")).not.toContainText("刷新完成");

  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  const noNewRecordsRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/records" && url.searchParams.get("includeTotal") === "1" && url.searchParams.get("refresh") === "1";
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  expect((await noNewRecordsRefresh).status()).toBe(200);
  await expect(page.getByTestId("records-refresh-status")).toContainText("暂无新增数据");

  await page.getByRole("button", { name: "列选择" }).click();
  for (const label of ["Session ID", "Parent Session ID", "Execution ID", "Trace ID", "Node Kind", "Fork", "Compaction"]) {
    await expect(page.locator("label").filter({ hasText: label }).first()).toBeVisible();
  }
  const cacheReadToggle = page.locator("label").filter({ hasText: "Cache Read" }).first().locator("input");
  await expect(cacheReadToggle).not.toBeChecked();
  await cacheReadToggle.check();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("records-column-settings-v5");
    return raw ? JSON.parse(raw).find((column: { key: string }) => column.key === "cacheReadTokens")?.visible : null;
  })).toBe(true);
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toBeVisible();
  await page.getByRole("button", { name: "列选择" }).click();
  await page.locator("label").filter({ hasText: "Cache Read" }).first().locator("input").uncheck();
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toHaveCount(0);

  const sessionIdToggle = page.locator("label").filter({ hasText: "Session ID" }).first().locator("input");
  await expect(sessionIdToggle).not.toBeChecked();
  await sessionIdToggle.check();
  await expect(page.getByRole("columnheader", { name: /Session ID/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("records-column-settings-v5");
    return raw ? JSON.parse(raw).find((column: { key: string }) => column.key === "sessionId")?.visible : null;
  })).toBe(true);
  await page.reload();
  await expect(page.getByRole("columnheader", { name: /Session ID/ })).toBeVisible();
  await expect(page.getByText("session-e2e-001", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Session ID" }).click();
  await expect.poll(() => recordListQueries.some((query) => (query.searchParams.get("sort") ?? "").startsWith("sessionId:desc"))).toBe(true);
  const searchInput = page.getByPlaceholder("搜索 Request ID / Model / Endpoint");
  await searchInput.fill("session-e2e-001");
  await searchInput.press("Enter");
  await expect.poll(() => recordListQueries.some((query) => query.searchParams.get("q") === "session-e2e-001")).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("records-column-settings-v5");
    return raw ? JSON.parse(raw).find((column: { key: string }) => column.key === "cacheReadTokens")?.visible : null;
  })).toBe(false);

  await recordRow.click();
  const dialog = page.getByRole("dialog", { name: "请求详情" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("调用链路")).toBeVisible();
  await expect(dialog.getByText("请求性能")).toBeVisible();
  await expect(dialog.getByText("Token 构成")).toBeVisible();

  await dialog.getByRole("tab", { name: "用量与计价" }).click();
  await expect(dialog.getByText("Token Accounting · complete")).toBeVisible();
  await expect(dialog.getByText("Token 用量明细")).toBeVisible();
  await expect(dialog.getByText("费用与计价证据")).toBeVisible();
  await expect(dialog.getByText("Cache Read Tokens")).toBeVisible();
  await expect(dialog.getByText("Input Tokens Details")).toBeVisible();
  await expect(dialog.getByText("Cached Tokens").last()).toBeVisible();
  await expect(dialog.getByText("Output Tokens Details")).toBeVisible();
  await expect(dialog.getByText("Reasoning Tokens").last()).toBeVisible();

  await dialog.getByRole("tab", { name: "诊断" }).click();
  await expect(dialog.getByRole("tab")).toHaveCount(4);
  await expect(dialog.getByRole("heading", { name: "凭据关联错误" })).toBeVisible();
  await expect(dialog.getByText(/不代表已证明的因果关系/)).toBeVisible();
  await expect(dialog.getByText(/未查到记录不代表没有错误/)).toBeVisible();
  await expect(dialog.getByText("Δ -1000 ms")).toBeVisible();
  await expect(dialog.getByText('<script>window.phase55Unsafe = true</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).phase55Unsafe)).toBeUndefined();
  await expect(dialog.getByRole("heading", { name: "响应头" })).toBeVisible();
  await expect(dialog.getByText("Client IP")).toBeVisible();
  const requestLogDownloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 CPA 请求日志" }).click();
  const requestLogDownload = await requestLogDownloadPromise;
  expect(requestLogDownload.suggestedFilename()).toBe("request-101.log");

  await dialog.getByRole("tab", { name: "原始字段" }).click();
  await expect(dialog.getByText("执行上下文")).toBeVisible();
  await expect(dialog.getByText("Session ID")).toBeVisible();
  await expect(dialog.getByText("session-e2e-001")).toBeVisible();
  await expect(dialog.getByText("execution-e2e-001")).toBeVisible();
  await expect(dialog.getByText("Raw Payload（已脱敏）")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭请求详情" }).click();
  await expect(dialog).toBeHidden();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /CSV/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("monitor-records-e2e.csv");
  await page.getByRole("button", { name: "列选择" }).click();
  await page.getByTestId("records-reset-columns").click();
  await expect(page.getByTestId("records-events-table").locator("thead th")).toHaveCount(12);
  await expect(page.getByRole("columnheader", { name: /Session ID/ })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toHaveCount(0);

  // The existing fixed sidebar occupies 224px; exercise the narrow content layout without covering the card.
  await page.setViewportSize({ width: 900, height: 844 });
  await expect(page.getByTestId("records-mobile-list")).toBeVisible();
  await expect(page.getByTestId("records-events-table")).toBeHidden();
  await page.getByTestId("records-mobile-list").getByRole("button", { name: "查看请求详情：req-e2e-001" }).click();
  await expect(page.getByRole("dialog", { name: "请求详情" })).toBeVisible();
});

test("records migrates untouched legacy columns and preserves customized v3 preferences", async ({ page }) => {
  await page.route("**/api/records?*", (route) => route.fulfill({
    status: 200,
    json: { items: [], nextCursor: null, totalCount: 0, filters: { models: [], routes: [], sources: [], providers: [], serviceTiers: [] } }
  }));
  const legacyOrder = [
    "occurredAt", "isError", "provider", "model", "requestId", "sessionId", "parentSessionId", "executionId", "traceId",
    "nodeKind", "isFork", "isCompaction", "route", "credentialName", "totalTokens", "inputTokens", "outputTokens",
    "reasoningTokens", "cacheReadTokens", "cacheCreationTokens", "latencyMs", "ttftMs", "cost", "modelAlias",
    "responseModel", "apiGroupLabel", "endpoint", "authType", "executorType", "accessProvider", "isNativeKey",
    "reasoningEffort", "serviceTier", "stream", "generate", "modelSubstituted", "cachedTokens", "statusCode"
  ];
  const legacyVisible = [
    "occurredAt", "isError", "provider", "model", "requestId", "route", "credentialName", "totalTokens",
    "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheCreationTokens", "latencyMs",
    "ttftMs", "cost"
  ];

  await login(page);
  await page.evaluate(({ order, visible }) => {
    localStorage.removeItem("records-column-settings-v5");
    localStorage.removeItem("records-column-settings-v4");
    localStorage.setItem("records-column-settings-v3", JSON.stringify(
      order.map((key) => ({ key, visible: visible.includes(key), width: null }))
    ));
  }, { order: legacyOrder, visible: legacyVisible });
  await page.goto("/records");
  await expect(page.getByTestId("records-events-table").locator("thead th")).toHaveCount(12);
  await expect(page.getByRole("columnheader", { name: "模式" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("records-column-settings-v5");
    return raw ? JSON.parse(raw).filter((column: { visible: boolean }) => column.visible).length : null;
  })).toBe(12);

  await page.evaluate(() => {
    const legacy = JSON.parse(localStorage.getItem("records-column-settings-v3") || "[]");
    const status = legacy.find((column: { key: string }) => column.key === "isError");
    if (status) status.visible = false;
    localStorage.setItem("records-column-settings-v3", JSON.stringify(legacy));
    localStorage.removeItem("records-column-settings-v5");
    localStorage.removeItem("records-column-settings-v4");
  });
  await page.reload();
  await expect(page.getByTestId("records-events-table").locator("thead th")).toHaveCount(15);
  await expect(page.getByRole("columnheader", { name: "状态" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "模式" })).toHaveCount(0);
  await page.getByRole("button", { name: "列选择" }).click();
  await page.getByTestId("records-reset-columns").click();
  await expect(page.getByTestId("records-events-table").locator("thead th")).toHaveCount(12);
});

test("Pricing Center exposes safe model linking, custom prices, channel multipliers and quote preview", async ({ page }) => {
  const fixture = {
    summary: { observedModels: 1, pricedModels: 0, unpricedModels: 1, ambiguousModels: 1, catalogOfferings: 2 },
    models: [{
      model: "gpt-test", provider: "relay", requests: 12, totalTokens: "12000",
      pricedRequests: 0, pricingStatus: "unpriced", priceMode: null, price: null, link: null,
      matchStatus: "ambiguous", matchKind: null,
      candidates: [
        { providerId: "openai", modelId: "gpt-test", name: "GPT Test", inputPricePer1M: "2", outputPricePer1M: "8", cacheReadPricePer1M: "1", cacheWritePricePer1M: "2" },
        { providerId: "relay", modelId: "gpt-test", name: "Relay GPT Test", inputPricePer1M: "3", outputPricePer1M: "9", cacheReadPricePer1M: "1.5", cacheWritePricePer1M: "3" }
      ],
      referenceCandidates: []
    }],
    prices: [], channels: [],
    syncState: [{ source: "models.dev", auto_sync_interval_hours: 24, last_success_at: "2026-11-19T12:00:00Z", last_hash: "a".repeat(64), latest_status: "success" }],
    snapshots: [], priceVersions: []
  };
  const writes: string[] = [];
  await page.route("**/api/pricing", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, json: fixture });
    writes.push("price");
    return route.fulfill({ status: 200, json: { ok: true, price: {} } });
  });
  await page.route("**/api/pricing/link", async (route) => {
    writes.push("link");
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route("**/api/pricing/channels", async (route) => {
    writes.push("channel");
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route("**/api/pricing/sync", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push("interval");
      return route.fulfill({ status: 200, json: { ok: true, state: {} } });
    }
    writes.push("sync");
    return route.fulfill({ status: 200, json: { status: "success", results: [] } });
  });
  await page.route("**/api/pricing/preview", async (route) => {
    writes.push("preview");
    return route.fulfill({ status: 200, json: { quote: { status: "priced", costNanos: "2287500", priceVersionId: 1, channelVersionId: 1, priceTierIndex: null, breakdown: { total_cost_nanos: "2287500" } } } });
  });

  await login(page);
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "模型价格体系" })).toBeVisible();
  await expect(page.getByText("gpt-test", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("存在歧义")).toBeVisible();

  await page.getByRole("button", { name: "关联" }).click();
  await expect.poll(() => writes.includes("link")).toBe(true);

  await page.getByRole("button", { name: "编辑 / 试算" }).click();
  await page.getByLabel("普通输入（USD / 1M）").fill("2");
  await page.getByLabel("缓存读取（USD / 1M）").fill("1");
  await page.getByLabel("输出（USD / 1M）").fill("8");
  await page.getByLabel("缓存写入（USD / 1M）").fill("2");
  await page.getByRole("button", { name: "保存 Custom 价格" }).click();
  await expect.poll(() => writes.includes("price")).toBe(true);

  await page.getByLabel("CPA 渠道名称").fill("relay");
  await page.getByLabel("备注").fill("E2E test channel");
  await page.getByRole("button", { name: "保存倍率" }).click();
  await expect.poll(() => writes.includes("channel")).toBe(true);

  await page.getByLabel("自动同步间隔").first().fill("12");
  await page.getByRole("button", { name: "保存间隔" }).first().click();
  await expect.poll(() => writes.includes("interval")).toBe(true);

  await page.getByLabel("模型 ID").last().fill("gpt-test");
  await page.getByRole("button", { name: "试算成本" }).click();
  await expect.poll(() => writes.includes("preview")).toBe(true);
  await expect(page.getByText("priced", { exact: true })).toBeVisible();
});
