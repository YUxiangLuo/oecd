import { expect, test } from "@playwright/test";

test("@real-api 登录、查看真实预计算指标并运行 outcome 回归", async ({ page }) => {
  test.skip(!process.env.REAL_API, "仅在真实 API 集成 job 中运行");
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await page.locator(".step-row").filter({ hasText: "GVC 总贸易流分解指标" }).click();
  await expect(page.getByRole("heading", { name: "GVC 总贸易流分解指标" })).toBeVisible();
  await expect(page.getByText("与 毛出口 的误差", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: /DVAex 国内增加值出口/ })).toBeVisible();

  await page.locator(".step-row").filter({ hasText: "GVC 贸易流教学实证回归" }).click();
  await expect(page.getByRole("heading", { name: "GVC 贸易流教学实证回归" })).toBeVisible();
  await page.getByRole("button", { name: "运行基准回归" }).click();
  await expect(page.locator(".verdict-card")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("95% 置信区间").first()).toBeVisible();
  await expect(page.getByText("不构成现实政策结论", { exact: false }).first()).toBeVisible();
});
