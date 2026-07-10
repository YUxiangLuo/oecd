import { expect, test } from "@playwright/test";

test("@real-api 登录、查看真实预计算指标并进入回归设计", async ({ page }) => {
  test.skip(!process.env.REAL_API, "仅在真实 API 集成 job 中运行");
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await page.locator(".step-row").filter({ hasText: "GVC 总贸易流分解指标" }).click();
  await expect(page.getByRole("heading", { name: "GVC 总贸易流分解指标" })).toBeVisible();
  await expect(page.getByText("与 毛出口 的误差", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: /DVAex 国内增加值出口/ })).toBeVisible();

  await page.locator(".step-row").filter({ hasText: "GVC 贸易流真实回归" }).click();
  await expect(page.getByRole("heading", { name: "GVC 贸易流真实回归" })).toBeVisible();
  await page.getByRole("button", { name: /运行回归/ }).click();
  await expect(page.getByRole("cell", { name: "treated×post" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("政策系数对照通过")).toBeVisible();
});
