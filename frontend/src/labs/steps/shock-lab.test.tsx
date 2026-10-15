import { afterEach, beforeEach, expect, mock, spyOn, test, type Mock } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step, TeachingCountriesResponse } from "../../types";
import { exampleWasChosen, representativeRow, ShockLab, stepTenGapNote, workedNumbers } from "./shock-lab";
import { SHOCK_ARTIFACT_CONTRACT_VERSION } from "./shock/shock-contract";

const step: Step = {
  n: 10, stage: 4, lab: "shock", status: "done", title: "政策冲击", goal: "",
  tasks: ["", "", ""], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};

const countryRow = (country: string, mean: number, industries = 44, surplus = mean > 0 ? 5000 : -800) => ({
  // Goods only (v8): 10 of the industries are services, never taxed.
  country, taxed: mean > 0, mean_exposure: mean, max_exposure: mean * 2, industries, goods_industries: industries - 10,
  exposed_industries: mean > 0 ? industries - 10 : 0,
  market_goods_surplus: surplus,
});
/** The whole-sample overview step 10 leads with; the real counts come from the release (the API), not the page. */
const countriesOverview: TeachingCountriesResponse = {
  version: "step10-tariff-teaching-v8", year: 2020, market: "USA", tariff_rate: 0.25, policy_year: 2018,
  taxed_rule: { basis: "first-year goods trade surplus with the market (ICIO sectors A-C)", min_million_usd: 1000, year: 2016, scope: "goods industries (ICIO sectors A-C)" },
  taxed_countries: 3, untaxed_countries: 2, entities: 210,
  countries: [countryRow("CAN", 0.143), countryRow("CRI", 0.0782), countryRow("BRN", 0.0142), countryRow("AUT", 0), countryRow("MEX", 0, 43)],
};
// Every test that renders the page gets the overview; a test that needs another answer re-mocks it.
let countriesSpy: Mock<typeof api.teachingCountries>;
beforeEach(() => { countriesSpy = spyOn(api, "teachingCountries").mockResolvedValue(countriesOverview); });
afterEach(() => { countriesSpy.mockRestore(); });

test("step 10 uses the dedicated teaching tariff panel independently of the old shock contract", () => {
  const meta: Meta = {
    years: [2016, 2020], countries: ["CHN", "USA"], sectors: ["C26"],
    dataset: { years: [2016, 2020], artifact_contract_version: SHOCK_ARTIFACT_CONTRACT_VERSION - 1 },
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  // One screen: the US tariff first (loading), then the variables of steps 11–14 on one example with its selectors.
  expect(html).toContain("美国对哪些国家加征关税？");
  expect(html).toContain("正在读取全部国家的关税暴露");
  expect(html.indexOf(">课程模拟 · 美国加征关税<")).toBeGreaterThan(-1);
  expect(html.indexOf(">课程模拟 · 美国加征关税<")).toBeLessThan(html.indexOf(">举例<"));
  expect(html).toContain("回归要用到的变量：以一个国家×行业为例");
  expect(html).toContain("课程模拟");
  expect(html).toContain("不是回归样本筛选");
  expect(html).toContain("例子国家");
  expect(html).toContain("对照国家（可选）");
  expect(html).toContain("不选对照国家");
  expect(html).not.toContain("国家 A");
  expect(html).not.toContain("对比国家 B");
  expect(html).toContain("步骤 11–14 会把回归结果换算到这个例子上");
  expect(html).toContain("正在读取关税数据");
  // The old long lead, the four-step card and the sample paragraph are gone.
  expect(html).not.toContain("默认国家是加拿大和墨西哥");
  expect(html).not.toContain("后面四步用它做什么");
  expect(html).not.toContain("政策事件");
  expect(html).not.toContain("解释变量（X）");
  expect(html).not.toContain("0.25 × 0.20 = 0.05");
  expect(html).not.toContain("不是下方所选国家的实际读数");
});

test("step 10 prefers the configured two-country industry example", () => {
  const meta: Meta = {
    years: [2016, 2017, 2018, 2019, 2020],
    countries: ["AUS", "CAN", "CHN", "CRI", "KOR", "MEX", "USA"],
    sectors: ["C26", "C29"],
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  expect(html).toContain('<option value="CAN" selected="">CAN 加拿大</option>');
  expect(html).toContain('<option value="AUS" selected="">AUS 澳大利亚</option>');
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
  await waitFor(() => expect(document.querySelector(".reg-boundary[role=status]")?.textContent).toContain("不在回归样本里"));
  expect(document.querySelector(".reg-boundary[role=status]")!.textContent).toContain("已记录的例子保持不变");
  expect(document.querySelector(".teaching-x-reason")).toBeNull();
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
  await waitFor(() => expect(document.querySelector(".reg-boundary[role=status]")?.textContent).toContain("CAN 加拿大 · C29 汽车及零部件 不在回归样本里"));
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
  await waitFor(() => expect(screen.getByText(/只看一个被加税国家时，图上只有它自己的 X 从 2018 年起上升；/)).toBeTruthy());
  expect(series).toHaveBeenCalledWith(["CAN"], "C29");
  expect((screen.getByRole("combobox", { name: "对照国家（可选）" }) as HTMLSelectElement).value).toBe("");
  expect(document.querySelectorAll(".teaching-example-summary li")).toHaveLength(1);
  // The example's own X = w × τ is its summary line.
  expect(document.querySelector(".teaching-example-summary li")!.textContent).toBe(
    "CAN 加拿大 · C29 汽车及零部件被加税：2020 年 X = w × τ = 90.00% × 25% = 22.50 个百分点",
  );
  // X jumps in one year: a step line whose jump and the policy marker both sit on 2018, read in percentage points.
  await waitFor(() => expect(document.querySelector('[data-mark-year="2018"]')).not.toBeNull());
  const svg = document.querySelector('[data-mark-year="2018"]')!.closest("svg")!;
  const marker = Number(svg.querySelector('[data-mark-year="2018"] line')!.getAttribute("x1"));
  const steps = [...svg.querySelectorAll('polyline[data-series="CAN"]')];
  expect(steps.length).toBe(4);
  // The 2017→2018 segment rises at its end, at the 2018 position where the marker line is.
  const jump = steps[1].getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number));
  expect(jump[1][0]).toBe(marker);
  expect(jump[2][0]).toBe(marker);
  expect(jump[2][1]).toBeLessThan(jump[1][1]);
  // The "2018 年起加税" label sits left of the marker, in the empty pre-tariff corner, clear of the jump.
  const markLabel = svg.querySelector('[data-mark-year="2018"] text')!;
  expect(markLabel.textContent).toBe("2018 年起加税");
  expect(markLabel.getAttribute("text-anchor")).toBe("end");
  expect(Number(markLabel.getAttribute("x"))).toBeLessThan(marker - 8);
  // Halfway up, not at the top where the jump to the top of the axis met it.
  expect(Number(markLabel.getAttribute("y"))).toBeGreaterThan(100);
  // One short note at the top says the tariff scenario and the four Y are generated by the course.
  expect(document.querySelector(".teaching-data-note")?.textContent).toContain("由课程按设定生成");
  expect(document.querySelector(".teaching-data-note")?.textContent).toContain("不是真实政策效应或官方宏观统计");
  expect(document.body.textContent).toContain("关税暴露 X · 个百分点");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls[0] as unknown[])[0]).toMatchObject({ compared: ["CAN"], teaching_country: "CAN", teaching_year: 2020 });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});


test("the step 10 gap note matches whether the two countries were taxed", () => {
  expect(stepTenGapNote([true, false])).toContain("两国差距的大小等于美国加税后被加税国家的 X");
  expect(stepTenGapNote([true, true])).toContain("差距来自对美出口份额 w 的不同");
  expect(stepTenGapNote([false, false])).toContain("没有差距");
  // The untaxed country as the example (gap negative) reads the same: the size of the gap, not its sign.
  expect(stepTenGapNote([false, true])).toBe(stepTenGapNote([true, false]));
  expect(stepTenGapNote([true])).toBeUndefined();
});

const tenYears = [2016, 2017, 2018, 2019, 2020];
/** The example's summary lines in the trend section, one per country: its own "X = w × τ = …". */
const summaryLines = () => [...document.querySelectorAll(".teaching-example-summary li")].map((li) => li.textContent!);
// The example's year table (the 75-country table under the ranking is bounded and scrolls too).
const YEAR_TABLE_ROWS = '[aria-label="所选例子的逐年变量表"] tbody tr';
const tenGroups = () => spyOn(api, "teachingGroups").mockResolvedValue({
  version: "step10-tariff-teaching-v5", years: tenYears, policy_year: 2018,
  sample: { rows: 10, entities: 2, countries: 2, industries: 1, taxed_countries: 1, untaxed_countries: 1 },
  industries: ["B05_06", "C26", "C29", "C30", "O"],
  outcomes: {} as never,
});
/** Five years of one country×industry: τ from 2018 when taxed, X = w × τ. */
const tenRows = (country: string, industry: string, w: number, taxed: boolean) => tenYears.map((year) => {
  const tau = taxed && year >= 2018 ? 0.25 : 0;
  return { country, industry, year, teaching_export_share_w: w, teaching_tariff_rate_tau: tau, teaching_tariff_exposure: w * tau };
});
const tenSeries = (rows: (countries: string[], industry: string) => ReturnType<typeof tenRows>) =>
  spyOn(api, "teachingSeries").mockImplementation(async (countries: string[], industry: string) => ({
    version: "step10-tariff-teaching-v5", disclaimer: "", total: 0, years: tenYears, rows: rows(countries, industry),
  }) as never);
const tenState = (data: Record<string, unknown> | undefined, save = mock(() => {}), materialLocked = false) =>
  ({ data, save, complete: false, syncing: false, syncError: null, syncNow: () => {}, materialLocked });
/** The 本步报告材料 card and its three lines: the state chip, the one-sentence summary and how the record is made. */
const materialCard = () => screen.getByRole("region", { name: "本步报告材料" });
const materialChip = () => materialCard().querySelector(".material-chip")!.textContent;
const materialSummary = () => materialCard().querySelector(".material-card-summary")!.textContent;
const materialHow = () => materialCard().querySelector(".material-card-how")?.textContent ?? "";

test("the worked example prefers the exposed row: taxed with X > 0 before a taxed w = 0 one", () => {
  const rows = [...tenRows("CHE", "B05_06", 0, true), ...tenRows("CAN", "B05_06", 0.93, true)];
  expect(representativeRow(rows, ["CHE", "CAN"], 2020)?.country).toBe("CAN");
  // Without an exposed row the taxed one comes first, then the first chosen.
  expect(representativeRow([...tenRows("MEX", "C29", 0.8, false), ...tenRows("CHE", "C29", 0, true)], ["MEX", "CHE"], 2020)?.country).toBe("CHE");
  expect(representativeRow(tenRows("MEX", "C29", 0.8, false), ["MEX"], 2020)?.country).toBe("MEX");
});

test("only an example the student picked counts as chosen; an older default save does not", () => {
  const defaults = { first: "CAN", second: "MEX", industry: "C29" };
  expect(exampleWasChosen(undefined, defaults)).toBe(false);
  expect(exampleWasChosen({ compared: ["CAN", "MEX"], teaching_industry: "C29" }, defaults)).toBe(false);
  expect(exampleWasChosen({ compared: ["CAN", "MEX"], teaching_industry: "C26" }, defaults)).toBe(true);
  expect(exampleWasChosen({ compared: ["CAN", "MEX"], teaching_industry: "C29", teaching_example_chosen: true }, defaults)).toBe(true);
  expect(exampleWasChosen({ compared: ["CHE"], teaching_industry: "C26", teaching_example_chosen: false }, defaults)).toBe(false);
});

test("a fresh step 10 always opens on C29 (the autos example), whatever step 9 looked at; a saved choice wins", async () => {
  const meta: Meta = { years: tenYears, countries: ["AUS", "CAN", "USA"], sectors: ["C26", "C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const save = mock(() => {});
  // Nothing saved yet: CAN vs AUS in C29, as the lead text says.
  render(<ShockLab meta={meta} step={step} state={tenState(undefined, save)} />);
  await waitFor(() => expect(series).toHaveBeenCalledWith(["CAN", "AUS"], "C29"));
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C29");
  expect(series).not.toHaveBeenCalledWith(expect.anything(), "C26");
  const lead = document.querySelector(".teaching-example-lead")!.textContent!;
  expect(lead).toContain("未被加税的澳大利亚");
  expect(lead).toContain("行业为 C29 汽车及零部件");
  expect(lead).not.toContain("步骤 9");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ teaching_industry: "C29", teaching_example_chosen: false });
  cleanup();
  // A saved step 10 choice keeps leading.
  const kept = mock(() => {});
  const saved = {
    compared: ["CAN", "AUS"], teaching_industry: "C26", teaching_example_chosen: true,
    teaching_observation: { country: "CAN", industry: "C26", year: 2020, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.125, version: "step10-tariff-teaching-v5" },
  };
  render(<ShockLab meta={meta} step={step} state={tenState(saved, kept)} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C26");
  expect(kept).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("both taxed, one with w = 0: each line works its own X, the exposed country is recorded, and nobody is told to switch", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CHE", "MEX"], sectors: ["B05_06"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "CAN" ? 0.93 : 0, true)));
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CHE", "CAN"], teaching_industry: "B05_06", teaching_example_chosen: true }, save)} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  const [che, can] = summaryLines();
  expect(che).toStartWith("CHE 瑞士 · B05_06");
  expect(che).toContain("被加税：2020 年 X = w × τ = 0.00% × 25% = 0 个百分点（不向美国出口：w = 0，所以 X = 0）");
  expect(can).toStartWith("CAN 加拿大 · B05_06");
  expect(can).toContain("被加税：2020 年 X = w × τ = 93.00% × 25% = 23.25 个百分点");
  // The old example-driven card and its tail sentence are gone.
  expect(document.body.textContent).not.toContain("税率相同时");
  const hint = document.querySelector(".teaching-example-hint")!.textContent!;
  expect(hint).toContain("图上 CAN 加拿大 的 X 就是加税带来的暴露");
  expect(hint).not.toContain("换一个行业或国家");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ teaching_country: "CAN" });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("one taxed and one untaxed: a tiny w keeps significant digits in its X = w × τ line; the untaxed one reads τ = 0%", async () => {
  const meta: Meta = { years: tenYears, countries: ["BRN", "CAN", "MEX"], sectors: ["C30"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "BRN" ? 0.000033 : 0.4, country === "BRN")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["BRN", "MEX"], teaching_industry: "C30", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  const [brn, mex] = summaryLines();
  expect(brn).toContain("被加税：2020 年 X = w × τ = 0.0033% × 25% = 0.00083 个百分点");
  expect(mex).toContain("未被加税：2020 年 X = w × τ = 40.00% × 0% = 0 个百分点");
  expect(document.body.textContent).not.toContain("税率相同时");
  expect(document.body.textContent).not.toContain("不到");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("the USA is named as the imposing country, never as an unaffected one", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  // After the sample change the USA has no rows in the teaching data.
  const series = tenSeries((countries, industry) => countries.filter((country) => country !== "USA").flatMap((country) => tenRows(country, industry, 0.5, true)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["USA", "CAN"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(screen.getByText(/不能作为例子/)).toBeTruthy());
  expect(document.body.textContent).toContain("美国是加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义");
  expect(document.body.textContent).not.toMatch(/没受加税影响|首年（2016 年）缺少必要数据/);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
  expect(stepTenGapNote([false, true], [false, true], [true, false])).toContain("美国的 X 记为 0 只是定义");
});

test("the recorded example is named on the page and follows the selection before submission", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C26", "C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  function Harness() {
    const [data, setData] = useState<Record<string, unknown> | undefined>(undefined);
    return <ShockLab meta={meta} step={step} state={tenState(data, mock((patch: Record<string, unknown>) => setData((value) => ({ ...value, ...patch }))) as never)} />;
  }
  render(<Harness />);
  // Nothing recorded yet: the card says so and that the record follows the choice by itself.
  expect(materialCard().className).toContain("material-card--missing");
  expect(materialChip()).toBe("尚未记录");
  expect(materialSummary()).toBe("尚未记录：关税数据加载后自动记录当前例子。");
  expect(materialHow()).toBe("随你的选择自动记录，无需另外保存。");
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  // The tariff data arrive: the example is recorded with the one-sentence label step 15 shows again.
  await waitFor(() => expect(materialSummary()).toBe("例子：CAN 加拿大（被加税） 对 MEX 墨西哥（未被加税） · C29 汽车及零部件"));
  expect(materialCard().className).toContain("material-card--recorded");
  expect(materialChip()).toBe("已记录");
  expect(materialHow()).toBe("当前例子就是已记录的材料；换国家或行业后自动更新。");
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "行业" }), { target: { value: "C26" } });
  await waitFor(() => expect(materialSummary()).toBe("例子：CAN 加拿大（被加税） 对 MEX 墨西哥（未被加税） · C26 计算机电子光学"));
  expect(materialHow()).toBe("当前例子就是已记录的材料；换国家或行业后自动更新。");
  // The card is the step's one material element; the old strip is gone.
  expect(materialCard().id).toBe("step-material-action");
  expect(document.querySelector(".teaching-example-record")).toBeNull();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("after submission, switching the example asks first, then confirms and keeps focus", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C26", "C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const submitted = {
    compared: ["CAN", "MEX"], teaching_industry: "C29", teaching_example_chosen: true,
    teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.125, version: "step10-tariff-teaching-v5" },
  };
  const save = mock(() => {});
  function Harness() {
    const [data, setData] = useState<Record<string, unknown>>(submitted);
    const record = (patch: Record<string, unknown>) => { save(); setData((value) => ({ ...value, ...patch })); };
    return <ShockLab meta={meta} step={step} state={tenState(data, mock(record) as never, true)} />;
  }
  render(<Harness />);
  // An older save without material_label reads as the recorded example; the card says the report is handed in.
  expect(materialChip()).toBe("已记录");
  expect(materialSummary()).toBe("CAN 加拿大 · C29 汽车及零部件（对比 MEX 墨西哥）");
  await waitFor(() => expect(materialHow()).toBe("当前例子就是已记录的材料；换国家或行业后自动更新。 报告已提交：浏览不再自动改动报告材料。"));
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "行业" }), { target: { value: "C26" } });
  const button = await screen.findByRole("button", { name: "改用当前例子作为报告材料（之后需在步骤 15 更新报告）" });
  expect(button.closest(".material-card")).toBe(materialCard());
  expect(materialCard().querySelectorAll("button.material-card-action")).toHaveLength(1);
  // Browsing after submission does not record: the card still names the submitted example and asks first.
  expect(materialSummary()).toBe("CAN 加拿大 · C29 汽车及零部件（对比 MEX 墨西哥）");
  expect(materialHow()).toBe("已记录的是另一个例子；换回或点下面的按钮即改为当前例子。 报告已提交：浏览不再自动改动报告材料。");
  expect(save).not.toHaveBeenCalled();
  button.focus();
  act(() => { fireEvent.click(button); });
  await waitFor(() => expect(materialSummary()).toBe("例子：CAN 加拿大（被加税） 对 MEX 墨西哥（未被加税） · C26 计算机电子光学"));
  expect(save).toHaveBeenCalledTimes(1);
  expect(materialHow()).toBe("当前例子就是已记录的材料；换国家或行业后自动更新。 报告已提交：浏览不再自动改动报告材料。请到步骤 15 更新报告并重新提交给老师。");
  expect(screen.queryByRole("button", { name: /改用当前例子/ })).toBeNull();
  // Focus moves to the card itself (the step's material element) when the button it was on disappears.
  expect(materialCard().id).toBe("step-material-action");
  expect(materialCard().tabIndex).toBe(-1);
  await waitFor(() => expect(document.activeElement).toBe(materialCard()));
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("an exact zero X reads 0 next to a tiny one, not 0.00", async () => {
  const meta: Meta = { years: tenYears, countries: ["KHM", "MEX"], sectors: ["B07_08"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "KHM" ? 0.000033 : 0.4, country === "KHM")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["KHM", "MEX"], teaching_industry: "B07_08", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  const [khm, mex] = summaryLines();
  expect(khm).toContain("2020 年 X = w × τ = 0.0033% × 25% = 0.00083 个百分点");
  expect(mex).toContain("2020 年 X = w × τ = 40.00% × 0% = 0 个百分点");
  expect(mex).not.toContain("= 0.00 个百分点");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("teaching data v10: the policy line and the rate tile name the two waves, with each wave's start", async () => {
  const waveOf = { CAN: 1, CRI: 2, BRN: 2 } as Record<string, number>;
  countriesSpy.mockResolvedValue({
    ...countriesOverview,
    version: "step10-tariff-teaching-v10",
    policy_years: [2018, 2019],
    waves: [
      { wave: 1, start_year: 2018, min_million_usd: 10000, countries: 1 },
      { wave: 2, start_year: 2019, min_million_usd: 1000, countries: 2 },
    ],
    countries: countriesOverview.countries.map((row) => ({
      ...row, wave: waveOf[row.country] ?? 0, start_year: { 1: 2018, 2: 2019 }[waveOf[row.country] ?? 0] ?? null,
    })),
  });
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  tenGroups();
  tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  await waitFor(() => expect(document.querySelector(".teaching-tiles")).not.toBeNull());
  expect(document.querySelector(".teaching-scenario")!.textContent).toBe(
    "以下为课程模拟情景，不是真实关税政策的历史记录。USA 美国分两批对 2016 年对美货物贸易顺差达到或超过 10 亿美元的 3 个国家的货物（农业、采矿业和制造业，ICIO 行业 A–C）加征 25% 关税："
      + "对美货物顺差 ≥ 100 亿美元的 1 国 2018 年起，其余 2 国 2019 年起；服务业不加税；其余 2 个国家未被加税。"
      + "名单和批次都按这条规则由 ICIO 数据确定；美国是加税方，不在回归样本中。",
  );
  expect([...document.querySelectorAll(".teaching-tiles li")].at(-1)!.textContent).toBe("25%第一批 1 国 2018 年起、第二批 2 国 2019 年起的税率（此前为 0）");
  expect(document.querySelector(".teaching-variables")!.textContent).toContain("τ 是美国加征的税率，第一批 2018 年起、第二批 2019 年起，此前为 0");
  cleanup();
});

test("step 10 reads top to bottom: the tariff, the three variables on one example, then every taxed country's X", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  await waitFor(() => expect(document.querySelector(".teaching-tiles")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".country-exposure")).not.toBeNull());
  const cards = [...document.querySelectorAll(".shock-workbench > section")];
  expect(cards.map((card) => card.querySelector(".reg-section-step")!.textContent)).toEqual(["课程模拟 · 美国加征关税", "举例", "各国的关税暴露"]);
  expect(cards.map((card) => card.querySelector("h3")!.textContent)).toEqual([
    "课程模拟中，美国对哪些国家加征关税？", "回归要用到的变量：以一个国家×行业为例", "3 个被加税国家的 X（从高到低）",
  ]);
  // Card 1: one policy sentence from the response and three tiles (the imposer is in the sentence, not a tile).
  const [tariff, variables, ranking] = cards;
  expect(tariff.querySelector(".teaching-scenario")!.textContent).toBe(
    "以下为课程模拟情景，不是真实关税政策的历史记录。2018 年起，USA 美国对 2016 年对美货物贸易顺差达到或超过 10 亿美元的 3 个国家的货物（农业、采矿业和制造业，ICIO 行业 A–C）加征 25% 关税，服务业不加税；其余 2 个国家未被加税。名单按这条规则由 ICIO 数据确定；美国是加税方，不在回归样本中。",
  );
  const tiles = [...tariff.querySelectorAll(".teaching-tiles li")].map((tile) => tile.textContent);
  expect(tiles).toEqual(["3 国被美国加税（对美货物顺差 ≥ 10 亿美元）", "2 国未被加税（X 始终为 0）", "25%2018 年起的税率（此前为 0）"]);
  expect(tariff.querySelector(".teaching-tiles li.imposer")).toBeNull();
  // Card 2: X, L1.X and the exchange-rate change, each with its source, before the example's selects.
  expect([...variables.querySelectorAll(".teaching-variables dt")].map((term) => term.textContent)).toEqual([
    "关税暴露 X = 首年对美出口份额 w × 加征税率 τ", "上一年的 X（L1.X）", "汇率变动", "GDP 对数与贸易开放度",
  ]);
  expect([...variables.querySelectorAll(".source-tag")].map((tag) => tag.textContent)).toEqual([
    "w：ICIO 数据", "τ：课程设定", "由 w、τ 计算", "课程生成", "课程生成", "ICIO 派生",
  ]);
  expect(variables.querySelector(".teaching-variables")!.compareDocumentPosition(variables.querySelector(".controls")!)
    & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Card 3: the sample sentence, the chart, and what steps 11–14 read.
  const lines = [...ranking.querySelectorAll(".teaching-one-line")].map((line) => line.textContent);
  expect(lines[0]).toBe("每条是一个国家 2020 年各货物行业的平均 X（服务业不加税，X = 0，不计入）。回归样本（货物和服务业都在内）：5 国的 210 个国家×行业 × 5 年 = 10 条记录。");
  expect(lines[1]).toBe("步骤 11–14 用每个国家×行业的 X、上一年的 X，控制汇率变动、GDP 对数和贸易开放度，分别对照四类指标 Y，读“X 每高 1 个百分点，Y 两年累计平均相差多少”。");
  // The rule is said once, in the policy line; the chart marks no example.
  expect(document.querySelector(".country-exposure-rule")).toBeNull();
  expect(document.querySelector(".country-exposure-note")!.textContent).toBe("悬停或用方向键查看每个国家的 X 与对美货物顺差。");
  expect(document.querySelectorAll("[data-highlight]")).toHaveLength(0);
  // The generated-data note stays as one line at the top; the CAN industry-mean worked card is gone.
  expect(document.querySelectorAll(".teaching-data-note")).toHaveLength(1);
  expect(document.querySelector(".teaching-x-card")).toBeNull();
  expect(document.body.textContent).not.toContain("后面四步用它做什么");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("the ranking chart stays the same whatever example is chosen: untaxed, the imposer or outside the sample", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CHN", "MEX", "USA"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  // MEX is untaxed; the USA has no rows; nobody has rows in O.
  const series = tenSeries((countries, industry) => countries
    .filter((country) => country !== "USA" && industry !== "O")
    .flatMap((country) => tenRows(country, industry, 0.8, country === "CAN")));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".country-exposure")).not.toBeNull());
  const chart = () => document.querySelector(".country-exposure")!.innerHTML;
  const shownChart = chart();
  const unchanged = () => {
    expect(chart()).toBe(shownChart);
    expect(document.querySelectorAll("[data-highlight]")).toHaveLength(0);
  };
  fireEvent.change(screen.getByRole("combobox", { name: "例子国家" }), { target: { value: "MEX" } });
  await waitFor(() => expect(summaryLines()[0]).toStartWith("MEX 墨西哥"));
  unchanged();
  fireEvent.change(screen.getByRole("combobox", { name: "例子国家" }), { target: { value: "USA" } });
  await waitFor(() => expect(screen.getByText(/不能作为例子/)).toBeTruthy());
  unchanged();
  fireEvent.change(screen.getByRole("combobox", { name: "例子国家" }), { target: { value: "CHN" } });
  fireEvent.change(screen.getByRole("combobox", { name: "行业" }), { target: { value: "O" } });
  await waitFor(() => expect(document.querySelector(".reg-boundary")?.textContent).toContain("不在回归样本里"));
  unchanged();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("the year-by-year table shows w, τ, X, last year's X and the exchange-rate change, and a second chart draws the rate", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CRI"], sectors: ["C29"] };
  const groups = tenGroups();
  // v10 rows: L1.X is X a year later; the first wave's currency falls from 2018.
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN").map((row, index, all) => ({
    ...row,
    teaching_tariff_exposure_lag1: index ? all[index - 1].teaching_tariff_exposure : 0,
    teaching_exchange_rate_change: country === "CAN" && row.year >= 2018 ? -6.4 : 0.3,
  }))));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CAN", "CRI"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelectorAll(".teaching-year-table tbody tr").length).toBe(10));
  expect([...document.querySelectorAll(".teaching-year-table thead th")].map((cell) => cell.textContent)).toEqual([
    "国家", "年份", "首年对美出口份额 w", "加征税率 τ", "关税暴露 X = w × τ", "上一年的 X（L1.X）", "汇率变动",
  ]);
  const canRows = [...document.querySelectorAll(".teaching-year-table tbody tr")].slice(0, 5).map((tr) => [...tr.children].map((cell) => cell.textContent));
  // A zero L1.X reads like a zero X ("0 个百分点", not "0.00").
  expect(canRows[2]).toEqual(["CAN 加拿大", "2018", "50.00%", "25%", "50.00% × 25% = 12.50 个百分点", "0 个百分点", "-6.4 个百分点"]);
  expect(canRows[3][5]).toBe("12.50 个百分点");
  // Neither example country is in a first wave here: the rate chart has no tariff line, and no cards of its own.
  expect(document.querySelectorAll(".teaching-example-charts [data-mark-year]")).toHaveLength(1);
  expect(document.querySelectorAll(".teaching-example-charts .comparison-summary")).toHaveLength(1);
  // The exchange-rate chart sits next to X's, marked at the first wave.
  expect(document.querySelectorAll(".teaching-example-charts figure, .teaching-example-charts svg").length).toBeGreaterThan(1);
  expect(document.body.textContent).toContain("汇率变动");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("a server without the taxed rule keeps the plain scenario, tile and chart notes", async () => {
  const { taxed_rule: _rule, ...legacy } = countriesOverview;
  countriesSpy.mockResolvedValue({ ...legacy, countries: legacy.countries.map(({ market_goods_surplus: _surplus, ...row }) => row) });
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  await waitFor(() => expect(document.querySelector(".teaching-tiles")).not.toBeNull());
  expect(document.querySelector(".teaching-tiles li.taxed")!.textContent).toBe("3 国被美国加税");
  expect(document.querySelectorAll(".teaching-tiles li")).toHaveLength(3);
  // No rule: no rule clause and no "名单按这条规则…".
  expect(document.querySelector(".teaching-scenario")!.textContent).toBe(
    "以下为课程模拟情景，不是真实关税政策的历史记录。2018 年起，USA 美国对 3 个国家的商品加征 25% 关税，其余 2 个国家未被加税。美国是加税方，不在回归样本中。",
  );
  expect(document.querySelector(".country-exposure-rule")).toBeNull();
  expect(document.querySelector(".country-exposure-note")!.textContent).toBe("悬停或用方向键查看每个国家的 X。");
  expect(document.body.textContent).not.toContain("对美货物");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("the whole-sample overview shows a loading line, then an error with a retry that refetches", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  countriesSpy.mockRejectedValueOnce(new Error("boom"));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  expect(screen.getByText("正在读取全部国家的关税暴露…")).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/全部国家的关税暴露读取失败/)).toBeTruthy());
  // The followed example still works while the overview is missing; there is no ranking without it.
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  expect(document.querySelector(".country-exposure")).toBeNull();
  const alert = screen.getByText(/全部国家的关税暴露读取失败/).closest(".error-box")!;
  fireEvent.click(alert.querySelector("button")!);
  await waitFor(() => expect(document.querySelector(".teaching-tiles")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".country-exposure")).not.toBeNull());
  expect(countriesSpy).toHaveBeenCalledTimes(2);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("A taxed with w = 0 and B taxed: A's own line says why its X is 0, and B is the recorded row", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "ISR", "MEX"], sectors: ["B05_06"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "ISR" ? 0 : 0.3, true)));
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["ISR", "MEX"], teaching_industry: "B05_06", teaching_example_chosen: true }, save)} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  const [isr, mex] = summaryLines();
  expect(isr).toContain("被加税：2020 年 X = w × τ = 0.00% × 25% = 0 个百分点（不向美国出口：w = 0，所以 X = 0）");
  expect(mex).toContain("被加税：2020 年 X = w × τ = 30.00% × 25% = 7.50 个百分点");
  // No switch to B is announced: the old example-driven card is gone.
  expect(document.body.textContent).not.toMatch(/所以这里用|对比国家 B/);
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ teaching_country: "MEX" });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("two countries not in the sample: plural wording in the one note under the selects", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CHN", "MEX"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries
    .filter(() => industry !== "O")
    .flatMap((country) => tenRows(country, industry, 0.5, true)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CHN", "MEX"], teaching_industry: "O", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".reg-boundary[role=status]")).not.toBeNull());
  expect(document.querySelector(".reg-boundary[role=status]")!.textContent).toBe(
    "CHN 中国、MEX 墨西哥 · O 公共管理与国防 不在回归样本里：这两个国家的这个行业在首年（2016 年）指标无法计算（例如没有出口或没有增加值），回归没有用到它们。请换国家或行业。",
  );
  expect(document.querySelectorAll(".reg-boundary")).toHaveLength(1);
  expect(document.querySelector(".teaching-x-reason")).toBeNull();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("w and X carry enough digits that the shown w × τ gives the shown X by hand", () => {
  // CHN B05_06: w = 0.0985%, X = 0.0246 pp. Two decimals read "0.10% × 25% = 0.02", but 0.10 × 0.25 = 0.025.
  expect(workedNumbers(0.000985, 0.25, 0.000985 * 0.25)).toMatchObject({ w: "0.10", x: "0.025", xDecimals: 3 });
  // Normal values keep two decimals; a tiny one keeps two significant digits; an exact zero is "0".
  expect(workedNumbers(0.93, 0.25, 0.93 * 0.25)).toMatchObject({ w: "93.00", x: "23.25", xDecimals: 2 });
  expect(workedNumbers(0.000033, 0.25, 0.000033 * 0.25)).toMatchObject({ w: "0.0033", x: "0.00083" });
  expect(workedNumbers(0, 0.25, 0)).toMatchObject({ w: "0.00", x: "0" });
  // Every shown pair checks: the shown w × 25%, rounded half up to X's digits, is the shown X.
  for (let w = 0.0001; w < 0.02; w += 0.000137) {
    const shown = workedNumbers(w, 0.25, w * 0.25);
    const units = Number(shown.w) * 0.25 * 10 ** shown.xDecimals;
    expect((Math.floor(units + 0.5 + 1e-9) / 10 ** shown.xDecimals).toFixed(shown.xDecimals)).toBe(shown.x);
  }
});

test("a small X reads with the digits that check, in the example's X = w × τ line and the trend card", async () => {
  const meta: Meta = { years: tenYears, countries: ["CHN", "CRI", "MEX"], sectors: ["B05_06"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "CHN" ? 0.000985 : 0.3, country === "CHN")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CHN", "CRI"], teaching_industry: "B05_06", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  const [chn, cri] = summaryLines();
  expect(chn).toContain("被加税：2020 年 X = w × τ = 0.10% × 25% = 0.025 个百分点");
  expect(cri).toContain("未被加税：2020 年 X = w × τ = 30.00% × 0% = 0 个百分点");
  await waitFor(() => expect(document.querySelector(".comparison-summary")).not.toBeNull());
  expect(document.querySelectorAll(".comparison-summary > div")[0].textContent).toContain("0.000 → 0.025");
  expect(document.body.textContent).not.toContain("= 0.02 个百分点");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

const RECORDED_CAN = {
  compared: ["CAN", "MEX"], teaching_industry: "C29", teaching_example_chosen: true,
  teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.93, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.2325, version: "step10-tariff-teaching-v5" },
};

test("the USA as A with a valid recorded example: one note, and the recorded example's X and trend stay", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.filter((country) => country !== "USA")
    .flatMap((country) => tenRows(country, industry, country === "CAN" ? 0.93 : 0.4, country === "CAN")));
  render(<ShockLab meta={meta} step={step} state={tenState(RECORDED_CAN)} />);
  fireEvent.change(screen.getByRole("combobox", { name: "例子国家" }), { target: { value: "USA" } });
  await waitFor(() => expect(document.body.textContent).toContain("已记录的例子 · 五年趋势"));
  // One note under the selects: the imposer, what to do, and what is shown instead.
  const notes = document.querySelectorAll(".reg-boundary");
  expect(notes).toHaveLength(1);
  expect(notes[0].textContent).toBe(
    "美国是加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义（w 是“对美出口份额”，美国不会向自己出口），不是数据缺失，不能作为例子。请换一个国家。下面仍显示已记录的例子 CAN 加拿大 · C29 汽车及零部件（对比 MEX 墨西哥）。",
  );
  expect(materialHow()).toContain("当前选择暂不能记录");
  expect(materialHow()).not.toContain("按钮");
  expect(materialCard().querySelector(".material-card-action")).toBeNull();
  expect(document.body.textContent).not.toContain("见上面的说明");
  // The recorded example's own lines replace the selection's: CAN · C29 against MEX.
  expect(summaryLines()).toEqual([
    "CAN 加拿大 · C29 汽车及零部件被加税：2020 年 X = w × τ = 93.00% × 25% = 23.25 个百分点",
    "MEX 墨西哥 · C29 汽车及零部件未被加税：2020 年 X = w × τ = 40.00% × 0% = 0 个百分点",
  ]);
  expect(document.body.textContent).not.toContain("这里用已记录的例子计算");
  expect(document.querySelector(".reg-section-step")).not.toBeNull();
  expect(document.body.textContent).toContain("已记录的例子 · 五年趋势");
  await waitFor(() => expect(document.querySelector('[data-mark-year="2018"]')).not.toBeNull());
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("ISR · D outside the sample while ISR · S is recorded: one note, and the recorded example stays", async () => {
  const meta: Meta = { years: tenYears, countries: ["ISR", "USA"], sectors: ["D", "S"] };
  const groups = spyOn(api, "teachingGroups").mockResolvedValue({
    version: "step10-tariff-teaching-v5", years: tenYears, policy_year: 2018,
    sample: { rows: 10, entities: 2, countries: 1, industries: 2, taxed_countries: 1, untaxed_countries: 0 },
    industries: ["D", "S"], outcomes: {} as never,
  });
  // ISR · D has no first-year data, so it is not in the sample.
  const series = tenSeries((countries, industry) => (industry === "D" ? [] : countries.flatMap((country) => tenRows(country, industry, 0.2, true))));
  const saved = {
    compared: ["ISR"], teaching_industry: "S", teaching_example_chosen: true,
    teaching_observation: { country: "ISR", industry: "S", year: 2020, teaching_export_share_w: 0.2, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.05, version: "step10-tariff-teaching-v5" },
  };
  render(<ShockLab meta={meta} step={step} state={tenState(saved)} />);
  fireEvent.change(screen.getByRole("combobox", { name: "行业" }), { target: { value: "D" } });
  await waitFor(() => expect(document.body.textContent).toContain("已记录的例子 · 五年趋势"));
  const notes = document.querySelectorAll(".reg-boundary");
  expect(notes).toHaveLength(1);
  expect(notes[0].textContent).toMatch(/^ISR 以色列 · D .* 不在回归样本里：这个国家的这个行业在首年（2016 年）指标无法计算（例如没有出口或没有增加值），回归没有用到它。请换一个国家或行业。下面仍显示已记录的例子 ISR 以色列 · S /);
  const [isr] = summaryLines();
  expect(isr).toStartWith("ISR 以色列 · S");
  expect(isr).toContain("被加税：2020 年 X = w × τ = 20.00% × 25% = 5.00 个百分点");
  expect(summaryLines()).toHaveLength(1);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("each country's trend card reads X at its own digits; the marker sits between 2017 and 2018", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CHN"], sectors: ["C29"] };
  const groups = tenGroups();
  // CAN reads 23.25 (two decimals); CHN's tiny w needs three ("0.025").
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "CAN" ? 0.93 : 0.000985, true)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CAN", "CHN"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".comparison-summary")).not.toBeNull());
  const cards = [...document.querySelectorAll(".comparison-summary > div")].map((card) => card.textContent);
  expect(cards[0]).toContain("+23.25 个百分点");
  expect(cards[0]).toContain("0.00 → 23.25");
  expect(cards[0]).not.toContain("23.250");
  expect(cards[1]).toContain("0.000 → 0.025");
  // The lines above the cards read X at the same digits.
  const [can, chn] = summaryLines();
  expect(can).toContain("= 93.00% × 25% = 23.25 个百分点");
  expect(chn).toContain("= 0.10% × 25% = 0.025 个百分点");
  const svg = document.querySelector('[data-mark-year="2018"]')!.closest("svg")!;
  const marker = Number(svg.querySelector('[data-mark-year="2018"] line')!.getAttribute("x1"));
  const dots = [...svg.querySelectorAll('[data-series-group="CAN"] circle')].map((dot) => Number(dot.getAttribute("cx")));
  expect(marker).toBeGreaterThan(dots[1]);
  expect(marker).toBeLessThan(dots[2]);
  expect(marker).toBeCloseTo((dots[1] + dots[2]) / 2);
  // The definition names the year τ (and so X) rises from 0.
  expect(document.querySelector(".teaching-variables")!.textContent).toContain("τ 是美国加征的税率，2018 年起，此前为 0");
  expect(document.body.textContent).not.toContain("跳起来");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("the yearly table shows w at one precision for every year of a unit (w is fixed at its first-year value)", async () => {
  const meta: Meta = { years: tenYears, countries: ["CRI", "ISR", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  // 0.248953 × 25% needs three decimals of w to check by hand; the zero-rate years must not drop back to two.
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.248953, country === "ISR")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["ISR"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelectorAll(YEAR_TABLE_ROWS).length).toBe(5));
  const wCells = [...document.querySelectorAll(YEAR_TABLE_ROWS)].map((tr) => tr.children[2]?.textContent);
  expect(new Set(wCells).size).toBe(1);
  groups.mockRestore(); series.mockRestore();
});

test("step 10's year-by-year table lists country A first, then B", async () => {
  cleanup();
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX"], sectors: ["C29"] };
  const groups = tenGroups();
  // The server sends the rows in alphabetical order.
  const series = tenSeries((_countries, industry) => [...tenRows("CAN", industry, 0.93, true), ...tenRows("MEX", industry, 0.4, false)]);
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["MEX", "CAN"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelectorAll(YEAR_TABLE_ROWS).length).toBe(10));
  const firstCells = [...document.querySelectorAll(YEAR_TABLE_ROWS)].map((tr) => tr.children[0]?.textContent);
  expect(firstCells.slice(0, 5).every((name) => name === "MEX 墨西哥")).toBe(true);
  expect(firstCells.slice(5).every((name) => name === "CAN 加拿大")).toBe(true);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("after the report is submitted, an unconfirmed step 10 selection is kept as browsing state", async () => {
  cleanup();
  const meta: Meta = { years: tenYears, countries: ["CAN", "CRI", "MEX"], sectors: ["C29", "C26"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const views: unknown[] = [];
  const locked = { ...tenState(RECORDED_CAN, mock(() => {}), true), saveView: (patch: unknown) => views.push(patch) };
  const first = render(<ShockLab meta={meta} step={step} state={locked} />);
  fireEvent.change(screen.getByRole("combobox", { name: "对照国家（可选）" }), { target: { value: "CRI" } });
  await waitFor(() => expect(views.at(-1)).toEqual({ browse_selection: { first: "CAN", second: "CRI", industry: "C29" } }));
  first.unmount();
  // Coming back: the selection on screen is the browsed one; the recorded example (CAN vs MEX) is unchanged.
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ ...RECORDED_CAN, browse_selection: { first: "CAN", second: "CRI", industry: "C29" } }, save, true)} />);
  expect((screen.getByRole("combobox", { name: "对照国家（可选）" }) as HTMLSelectElement).value).toBe("CRI");
  await waitFor(() => expect(materialSummary()).toBe("CAN 加拿大 · C29 汽车及零部件（对比 MEX 墨西哥）"));
  expect(materialHow()).toContain("已记录的是另一个例子");
  expect(materialHow()).toContain("报告已提交：浏览不再自动改动报告材料。");
  expect(save).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("goods only: a taxed country's service industry reads as not taxed, with a hint to pick a goods industry", async () => {
  const meta: Meta = { years: tenYears, countries: ["AUT", "CAN", "USA"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  // CAN is on the taxed list, but O (public administration) is a service: τ stays 0, as for untaxed AUT.
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, false)));
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CAN", "AUT"], teaching_industry: "O" }, save)} />);
  await waitFor(() => expect(document.querySelectorAll(".teaching-example-summary li")).toHaveLength(2));
  const items = [...document.querySelectorAll(".teaching-example-summary li")].map((item) => item.textContent);
  expect(items[0]).toContain("被加税国家，但服务业不加税：2020 年 X = w × τ = 50.00% × 0% = 0 个百分点");
  expect(items[1]).toContain("未被加税：");
  expect(document.querySelector(".teaching-example-hint")!.textContent).toBe(
    "服务业不在加税范围内（美国只对货物行业 A–C 加税），所以任何国家这个行业的 X 都是 0；换一个货物行业（如 C29 汽车及零部件）才能看到加税带来的暴露。",
  );
  expect(document.body.textContent).toContain("服务业不加税：两国这个行业的 X 都为 0，没有差距");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({
    material_label: "例子：CAN 加拿大（被加税） 对 AUT 奥地利（未被加税） · O 公共管理与国防（服务业不加税）",
    teaching_observation: { teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0 },
  });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

for (const locked of [false, true]) test(`service labels already saved ${locked ? "in a submitted report" : "before submission"} recover after overview failure without changing material`, async () => {
  const meta: Meta = { years: tenYears, countries: ["AUT", "CAN", "USA"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, false)));
  countriesSpy.mockRejectedValueOnce(new Error("network unavailable"));
  const saved = {
    compared: ["CAN", "AUT"], teaching_industry: "O", teaching_example_chosen: true,
    material_label: "例子：CAN 加拿大（未被加税） 对 AUT 奥地利（未被加税） · O 公共管理与国防",
    teaching_observation: { country: "CAN", industry: "O", year: 2020, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0, version: "step10-tariff-teaching-v5" },
  };
  const before = JSON.stringify(saved);
  const save = mock(() => {});
  try {
    render(<ShockLab meta={meta} step={step} state={tenState(saved, save, locked)} />);
    await screen.findByRole("alert");
    await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
    expect(materialSummary()).toBe("例子：CAN 加拿大 对 AUT 奥地利 · O 公共管理与国防");
    expect(materialChip()).toBe("已记录");
    expect(summaryLines()[0]).toContain("该行业未加税（国家税况暂不可用）");
    expect(document.querySelector(".teaching-example-hint")?.textContent).toContain("也可能因为该行业免税");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(materialSummary()).toBe("例子：CAN 加拿大（被加税） 对 AUT 奥地利（未被加税） · O 公共管理与国防（服务业不加税）"));
    expect(series).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).toBe(before);
  } finally {
    groups.mockRestore();
    series.mockRestore();
    cleanup();
  }
});

test("the recorded example fallback reports loading and failure, then retries only its own request", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  let rejectRecorded!: (error: Error) => void;
  let resolveRecorded!: (value: never) => void;
  let recordedCalls = 0;
  const series = spyOn(api, "teachingSeries").mockImplementation((countries, industry) => {
    if (countries.includes("USA")) return Promise.resolve({
      version: "step10-tariff-teaching-v5", disclaimer: "", total: 5, years: tenYears,
      rows: tenRows("MEX", industry, 0.4, false),
    } as never);
    recordedCalls += 1;
    return recordedCalls === 1
      ? new Promise<never>((_resolve, reject) => { rejectRecorded = reject; })
      : new Promise<never>((resolve) => { resolveRecorded = resolve; });
  });
  const saved = { ...RECORDED_CAN, browse_selection: { first: "USA", second: "MEX", industry: "C29" } };
  const before = JSON.stringify(saved);
  const save = mock(() => {});
  try {
    render(<ShockLab meta={meta} step={step} state={tenState(saved, save, true)} />);
    await screen.findByText("正在读取已记录例子的关税数据；报告材料保持不变…");
    expect(materialChip()).toBe("已记录");
    await act(async () => { rejectRecorded(new Error("network unavailable")); });
    expect(screen.getByRole("alert").textContent).toContain("已记录例子的关税数据读取失败");
    expect(screen.getByRole("alert").textContent).toContain("报告材料保持不变");
    fireEvent.click(screen.getByRole("button", { name: "重试已记录例子" }));
    await screen.findByText("正在读取已记录例子的关税数据；报告材料保持不变…");
    await act(async () => { resolveRecorded({
      version: "step10-tariff-teaching-v5", disclaimer: "", total: 10, years: tenYears,
      rows: [...tenRows("CAN", "C29", 0.93, true), ...tenRows("MEX", "C29", 0.4, false)],
    } as never); });
    await screen.findByText("已记录的例子 · 五年趋势 · 两国使用同一刻度");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(series.mock.calls.filter(([countries]) => countries.includes("USA"))).toHaveLength(1);
    expect(series.mock.calls.filter(([countries]) => countries.includes("CAN"))).toHaveLength(2);
    expect(countriesSpy).toHaveBeenCalledTimes(1);
    expect(groups).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).toBe(before);
  } finally {
    groups.mockRestore();
    series.mockRestore();
    cleanup();
  }
});

test("two taxed countries: the comparison country's jump sits beside the first one's, not hidden under it", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country, index) => tenRows(country, industry, index ? 0.4 : 0.9, true)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CAN", "MEX"], teaching_industry: "C29" })} />);
  await waitFor(() => expect(document.querySelectorAll('polyline[data-series="MEX"]').length).toBeGreaterThan(1));
  const riserX = (country: string) => {
    const points = [...document.querySelectorAll(`polyline[data-series="${country}"]`)][1].getAttribute("points")!
      .split(" ").map((point) => point.split(",").map(Number));
    return points[1][0];
  };
  expect(riserX("MEX")).toBe(riserX("CAN") + 5);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("teaching data v10: a service example of a second-wave country marks that country's start, said to be on goods", async () => {
  const waveOf = { CAN: 1, CRI: 2, BRN: 2 } as Record<string, number>;
  countriesSpy.mockResolvedValue({
    ...countriesOverview,
    version: "step10-tariff-teaching-v10",
    policy_years: [2018, 2019],
    waves: [
      { wave: 1, start_year: 2018, min_million_usd: 10000, countries: 1 },
      { wave: 2, start_year: 2019, min_million_usd: 1000, countries: 2 },
    ],
    countries: countriesOverview.countries.map((row) => ({
      ...row, wave: waveOf[row.country] ?? 0, start_year: { 1: 2018, 2: 2019 }[waveOf[row.country] ?? 0] ?? null,
    })),
  });
  const meta: Meta = { years: tenYears, countries: ["AUT", "CRI", "USA"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, false)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CRI", "AUT"], teaching_industry: "O" })} />);
  await waitFor(() => expect(document.querySelector("[data-mark-year]")).not.toBeNull());
  // Not the first wave's 2018: CRI's own tariff began in 2019, and on goods only.
  expect(document.querySelector('[data-mark-year="2018"]')).toBeNull();
  expect(document.querySelector('[data-mark-year="2019"] text')!.textContent).toBe("2019 年起对货物加税");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});
