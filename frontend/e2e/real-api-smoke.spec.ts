import { expect, test } from "@playwright/test";

test("@real-api 登录、查看真实预计算指标并运行 outcome 回归", async ({ page }) => {
  test.skip(!process.env.REAL_API, "仅在真实 API 集成 job 中运行");
  await page.goto("/");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "跳过介绍" }).click();

  await page.locator(".step-row").filter({ hasText: "贸易政策冲击数据接入" }).click();
  const shockEvent = page.getByRole("button", { name: /美国301对华关税.*宣布 2018-06-15/ });
  await shockEvent.click();
  await expect(shockEvent).toHaveAttribute("aria-pressed", "true");
  const selectedSector = page.locator(".shock-panel-controls select").nth(3);
  await expect(selectedSector).toHaveValue(/.+/);
  const selectedSectorLabel = (await selectedSector.locator("option:checked").textContent())?.trim() ?? "";
  expect(selectedSectorLabel).not.toBe("");
  await expect(page.locator(".selected-event-card")).toContainText(`2018 · 关税冲击 · CHN 中国 · ${selectedSectorLabel}`);
  await expect(page.locator(".shock-panel-table")).toContainText(selectedSectorLabel);

  await page.locator(".step-row").filter({ hasText: "GVC 总贸易流分解指标" }).click();
  await expect(page.getByRole("heading", { name: "GVC 总贸易流分解指标" })).toBeVisible();
  await expect(page.getByText("与 毛出口 的误差", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: /DVAex 国内增加值出口/ })).toBeVisible();

  const taxsubExplainer = page.locator(".taxsub-explainer");
  await expect(taxsubExplainer).toBeVisible();
  await expect(taxsubExplainer).not.toContainText("正在加载计算示例…");
  const taxsubExample = taxsubExplainer.locator(".taxsub-example-button");
  if (await taxsubExample.count()) {
    await taxsubExample.click();
    await expect(taxsubExample).toHaveAttribute("aria-pressed", "true");
    const exampleCountry = page.locator(".demo-card select").nth(1);
    const exampleSector = page.locator(".demo-card select").nth(2);
    await expect(exampleCountry).toHaveValue(/.+/);
    await expect(exampleSector).toHaveValue(/.+/);
    await expect(page.locator(".section-head + .controls select").first()).toHaveValue(await exampleCountry.inputValue());
  } else {
    await expect(taxsubExplainer.locator(".taxsub-example-status")).toHaveText("当前数据中没有满足展示条件的负值示例。");
  }

  await page.locator(".step-row").filter({ hasText: "GVC 贸易流教学实证回归" }).click();
  await expect(page.getByRole("heading", { name: "GVC 贸易流教学实证回归" })).toBeVisible();
  await page.getByRole("button", { name: "运行基准回归" }).click();
  await expect(page.locator(".verdict-card")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("95% 置信区间").first()).toBeVisible();
  await expect(page.getByText("不构成现实政策结论", { exact: false }).first()).toBeVisible();
});
