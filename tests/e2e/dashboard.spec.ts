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
});

test("login and all dashboard pages render with JSON API responses", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const apiFailures: Array<{ url: string; status: number; contentType: string; body: string }> = [];
  const apiTasks: Promise<void>[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${page.url()} :: ${error.stack || error.message}`));
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
  await page.route("**/api/sync", (route) => route.fulfill({ status: 200, json: { authFilesSynced: 0 } }));

  await login(page);
  await expect(page.getByRole("heading", { name: "Usage Dashboard" })).toBeVisible();

  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "数据探索" })).toBeVisible();

  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "调用记录" })).toBeVisible();
  await page.waitForTimeout(500);
  await Promise.all(apiTasks);

  expect({ pageErrors, consoleErrors, requestFailures, apiFailures }).toEqual({
    pageErrors: [], consoleErrors: [], requestFailures: [], apiFailures: []
  });
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
    generate: false,
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
    pricingStatus: "priced"
  };
  const detail = {
    ...summary,
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
    createdAt: "2026-11-19T06:00:02.000Z"
  };

  const recordListQueries: URL[] = [];

  await page.route("**/api/records?*", (route) => {
    recordListQueries.push(new URL(route.request().url()));
    return route.fulfill({
      status: 200,
      json: {
        items: [summary],
        nextCursor: null,
        filters: { models: ["gpt-6"], routes: ["****1234"], sources: ["primary-account"], providers: ["OpenAI"], serviceTiers: ["priority"] }
      }
    });
  });
  await page.route("**/api/records/detail?*", (route) => route.fulfill({ status: 200, json: { item: detail } }));
  await page.route("**/api/records/export?*", (route) => route.fulfill({
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="monitor-records-e2e.csv"'
    },
    body: "request_id,model\r\nreq-e2e-001,gpt-6\r\n"
  }));

  await login(page);
  await page.goto("/records");

  await expect(page.getByRole("columnheader", { name: /Request ID/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Cache Write/ })).toBeVisible();
  await page.getByRole("button", { name: "列选择" }).click();
  for (const label of ["Session ID", "Parent Session ID", "Execution ID", "Trace ID", "Node Kind", "Fork", "Compaction"]) {
    await expect(page.locator("label").filter({ hasText: label }).first()).toBeVisible();
  }
  await page.getByRole("button", { name: "列选择" }).click();

  await page.getByRole("button", { name: "列选择" }).click();
  const cacheReadToggle = page.locator("label").filter({ hasText: "Cache Read" }).first().locator("input");
  await expect(cacheReadToggle).toBeChecked();
  await cacheReadToggle.uncheck();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("records-column-settings-v3");
    return raw ? JSON.parse(raw).find((column: { key: string }) => column.key === "cacheReadTokens")?.visible : null;
  })).toBe(false);
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("columnheader", { name: /Cache Read/ })).toHaveCount(0);
  await page.getByRole("button", { name: "列选择" }).click();
  await page.locator("label").filter({ hasText: "Cache Read" }).first().locator("input").check();
  const sessionIdToggle = page.locator("label").filter({ hasText: "Session ID" }).first().locator("input");
  await expect(sessionIdToggle).not.toBeChecked();
  await sessionIdToggle.check();
  await expect(page.getByRole("columnheader", { name: /Session ID/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("records-column-settings-v3");
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
    const raw = localStorage.getItem("records-column-settings-v3");
    return raw ? JSON.parse(raw).find((column: { key: string }) => column.key === "cacheReadTokens")?.visible : null;
  })).toBe(true);

  await page.getByText("req-e2e-001", { exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "请求详情" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("session-e2e-001")).toBeVisible();
  await expect(dialog.getByText("execution-e2e-001")).toBeVisible();
  await expect(dialog.getByText("Cache Read Tokens")).toBeVisible();
  await expect(dialog.getByText("Token Accounting")).toBeVisible();
  await expect(dialog.getByText("Response Headers（已脱敏）")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭请求详情" }).click();
  await expect(dialog).toBeHidden();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /CSV/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("monitor-records-e2e.csv");
});
