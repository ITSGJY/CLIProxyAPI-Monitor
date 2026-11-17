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
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || "unknown"}`));
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
