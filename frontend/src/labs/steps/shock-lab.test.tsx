import { expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step } from "../../types";
import { ShockLab, stepTenGapNote } from "./shock-lab";
import { SHOCK_ARTIFACT_CONTRACT_VERSION } from "./shock/shock-contract";

const step: Step = {
  n: 10, stage: 4, lab: "shock", status: "done", title: "政策冲击", goal: "",
  tasks: ["", "", ""], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};

test("step 10 uses the dedicated teaching tariff panel independently of the old shock contract", () => {
  const meta: Meta = {
    years: [2016, 2020], countries: ["CHN", "USA"], sectors: ["C26"],
    dataset: { years: [2016, 2020], artifact_contract_version: SHOCK_ARTIFACT_CONTRACT_VERSION - 1 },
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  // One screen: the question, the two selectors and the loading chart; no separate variable primer.
  expect(html).toContain("关税暴露 X 怎样随年份变化");
  expect(html).not.toContain("模拟");
  expect(html).toContain("国家 A");
  expect(html).toContain("对比国家 B");
  expect(html).toContain("不选对比国家");
  expect(html).toContain("步骤 11–14 会把回归结果换算到你选的例子上");
  expect(html).toContain("正在读取关税面板");
  expect(html).not.toContain("政策事件");
  expect(html).not.toContain("解释变量（X）");
  expect(html).not.toContain("0.25 × 0.20 = 0.05");
  expect(html).not.toContain("不是下方所选国家的实际读数");
});

test("step 10 prefers the configured two-country industry example", () => {
  const meta: Meta = {
    years: [2016, 2017, 2018, 2019, 2020],
    countries: ["CAN", "CHN", "KOR", "MEX", "USA"],
    sectors: ["C26", "C29"],
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  expect(html).toContain('<option value="CAN" selected="">CAN 加拿大</option>');
  expect(html).toContain('<option value="MEX" selected="">MEX 墨西哥</option>');
  expect(html).toContain('<option value="C29" selected="">C29 汽车及零部件</option>');
});

test("step 10 keeps the saved example when the chosen unit is not in the teaching sample, and only offers sampled industries", async () => {
  const meta: Meta = { years: [2016, 2017, 2018, 2019, 2020], countries: ["CAN", "MEX", "USA"], sectors: ["C29", "T"] };
  const groups = spyOn(api, "teachingGroups").mockResolvedValue({
    version: "step10-tariff-teaching-v5", years: meta.years, policy_year: 2018,
    sample: { rows: 10, entities: 2, countries: 2, industries: 1, taxed_countries: 1, untaxed_countries: 1 },
    industries: ["C29"],
    outcomes: {} as never,
  });
  const row = (country: string, year: number) => ({
    country, industry: "C29", year, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0,
  });
  // Only CAN has rows: MEX·C29 is not in the sample.
  const series = spyOn(api, "teachingSeries").mockResolvedValue({
    version: "step10-tariff-teaching-v5", disclaimer: "", total: 5, years: meta.years,
    rows: meta.years.map((year) => row("CAN", year)),
  } as never);
  const save = mock(() => {});
  const saved = {
    compared: ["CAN", "MEX"], teaching_industry: "C29",
    teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.9, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.225, version: "step10-tariff-teaching-v5" },
  };
  render(<ShockLab meta={meta} step={step} state={{ data: saved, save, complete: false, syncing: false, syncError: null, syncNow: () => {} }} />);
  await waitFor(() => expect(screen.getByText(/不在回归样本中/)).toBeTruthy());
  expect(screen.getByText(/已记录的例子保持不变/)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("option", { name: "T 家庭自用生产" })).toBeNull());
  expect(screen.getByRole("option", { name: "C29 汽车及零部件" })).toBeTruthy();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("step 10 keeps the saved example when a chosen unit has no row in the representative year", async () => {
  const meta: Meta = { years: [2016, 2017, 2018, 2019, 2020], countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = spyOn(api, "teachingGroups").mockResolvedValue({
    version: "step10-tariff-teaching-v5", years: meta.years, policy_year: 2018,
    sample: { rows: 10, entities: 2, countries: 2, industries: 1, taxed_countries: 1, untaxed_countries: 1 },
    industries: ["C29"],
    outcomes: {} as never,
  });
  const row = (country: string, year: number) => ({
    country, industry: "C29", year, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0,
  });
  // CAN has rows, but not for 2020, the year the example reads; MEX is complete.
  const series = spyOn(api, "teachingSeries").mockResolvedValue({
    version: "step10-tariff-teaching-v5", disclaimer: "", total: 9, years: meta.years,
    rows: [...meta.years.filter((year) => year < 2020).map((year) => row("CAN", year)), ...meta.years.map((year) => row("MEX", year))],
  } as never);
  const save = mock(() => {});
  const saved = {
    compared: ["CAN", "MEX"], teaching_industry: "C29",
    teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.9, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.225, version: "step10-tariff-teaching-v5" },
  };
  render(<ShockLab meta={meta} step={step} state={{ data: saved, save, complete: false, syncing: false, syncError: null, syncNow: () => {} }} />);
  await waitFor(() => expect(screen.getByText(/CAN 加拿大 · C29 汽车及零部件 不在回归样本中/)).toBeTruthy());
  expect(save).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("step 10 can follow a single taxed country and records it alone", async () => {
  const meta: Meta = { years: [2016, 2017, 2018, 2019, 2020], countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = spyOn(api, "teachingGroups").mockResolvedValue({
    version: "step10-tariff-teaching-v5", years: meta.years, policy_year: 2018,
    sample: { rows: 10, entities: 2, countries: 2, industries: 1, taxed_countries: 1, untaxed_countries: 1 },
    industries: ["C29"],
    outcomes: {} as never,
  });
  const series = spyOn(api, "teachingSeries").mockResolvedValue({
    version: "step10-tariff-teaching-v5", disclaimer: "", total: 5, years: meta.years,
    rows: meta.years.map((year) => ({
      country: "CAN", industry: "C29", year, teaching_export_share_w: 0.9,
      teaching_tariff_rate_tau: year >= 2018 ? 0.25 : 0, teaching_tariff_exposure: year >= 2018 ? 0.225 : 0,
    })),
  } as never);
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={{ data: { compared: ["CAN"], teaching_industry: "C29" }, save, complete: false, syncing: false, syncError: null, syncNow: () => {} }} />);
  await waitFor(() => expect(screen.getByText(/只看一个加税国家时/)).toBeTruthy());
  expect(series).toHaveBeenCalledWith(["CAN"], "C29");
  expect((screen.getByRole("combobox", { name: "对比国家 B" }) as HTMLSelectElement).value).toBe("");
  expect(document.querySelectorAll(".teaching-example-summary li")).toHaveLength(1);
  expect(screen.getByText(/所以 X = 90\.00% × 25% =/)).toBeTruthy();
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls[0] as unknown[])[0]).toMatchObject({ compared: ["CAN"], teaching_country: "CAN", teaching_year: 2020 });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});


test("the step 10 gap note matches whether the two countries were taxed", () => {
  expect(stepTenGapNote([true, false])).toContain("就是加税那年起的 X");
  expect(stepTenGapNote([true, true])).toContain("差距来自出口依赖 w 的不同");
  expect(stepTenGapNote([false, false])).toContain("没有差距");
  expect(stepTenGapNote([true])).toBeUndefined();
});
