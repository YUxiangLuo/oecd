import { expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step } from "../../types";
import { ShockLab } from "./shock-lab";
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
  expect(html).toContain("解释变量（X）");
  expect(html).toContain("国家 A");
  expect(html).toContain("国家 B");
  expect(html).toContain("选一个例子跟着走");
  expect(html).toContain("步骤 11–14 会把回归结果换算到你选的例子上");
  expect(html).toContain("正在读取教学关税面板");
  expect(html).not.toContain("政策事件");
  expect(html).toContain("0.25 × 0.20 = 0.05，即 5%");
  expect(html).toContain("X 从 5% 变为 6%，增加的是 1 个百分点");
  expect(html).toContain("不是下方所选国家的实际读数");
  expect(html).toContain("前两年税率为 0");
  expect(html).toContain("后三年统一为 10%");
  expect(html).toContain("Y 仍会因扰动而变化");
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
    version: "step10-tariff-teaching-v2", years: meta.years, policy_year: 2018,
    sample: { rows: 10, entities: 2, countries: 2, industries: 1, taxed_countries: 1, untaxed_countries: 1 },
    industries: ["C29"],
    outcomes: {} as never,
  });
  const row = (country: string, year: number) => ({
    country, industry: "C29", year, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0,
  });
  // Only CAN has rows: MEX·C29 is not in the sample.
  const series = spyOn(api, "teachingSeries").mockResolvedValue({
    version: "step10-tariff-teaching-v2", disclaimer: "", total: 5, years: meta.years,
    rows: meta.years.map((year) => row("CAN", year)),
  } as never);
  const save = mock(() => {});
  const saved = {
    compared: ["CAN", "MEX"], teaching_industry: "C29",
    teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.9, teaching_tariff_rate_tau: 0.1, teaching_tariff_exposure: 0.09, version: "step10-tariff-teaching-v2" },
  };
  render(<ShockLab meta={meta} step={step} state={{ data: saved, save, complete: false, syncing: false, syncError: null, syncNow: () => {} }} />);
  await waitFor(() => expect(screen.getByText(/不在教学样本中/)).toBeTruthy());
  expect(screen.getByText(/已记录的例子保持不变/)).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("option", { name: "T 家庭自用生产" })).toBeNull());
  expect(screen.getByRole("option", { name: "C29 汽车及零部件" })).toBeTruthy();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});
