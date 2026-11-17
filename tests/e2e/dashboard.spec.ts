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

test("login and all three dashboard pages render without browser errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await login(page);
  await expect(page.getByRole("heading", { name: "Usage Dashboard" })).toBeVisible();

  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "数据探索" })).toBeVisible();

  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "调用记录" })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
