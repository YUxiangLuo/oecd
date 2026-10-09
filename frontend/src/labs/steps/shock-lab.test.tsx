import { afterEach, beforeEach, expect, mock, spyOn, test, type Mock } from "bun:test";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step, TeachingCountriesResponse } from "../../types";
import { exampleWasChosen, fallbackWorkedCountry, representativeRow, ShockLab, stepTenGapNote, workedNumbers } from "./shock-lab";
import { CountryExposureChart } from "../../viz/regression/country-exposure";
import { SHOCK_ARTIFACT_CONTRACT_VERSION } from "./shock/shock-contract";

const step: Step = {
  n: 10, stage: 4, lab: "shock", status: "done", title: "政策冲击", goal: "",
  tasks: ["", "", ""], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};

const countryRow = (country: string, mean: number, industries = 44, surplus = mean > 0 ? 5000 : -800) => ({
  country, taxed: mean > 0, mean_exposure: mean, max_exposure: mean * 2, industries, exposed_industries: mean > 0 ? industries : 0,
  market_goods_surplus: surplus,
});
/** The whole-sample overview step 10 leads with; the real counts come from the release (the API), not the page. */
const countriesOverview: TeachingCountriesResponse = {
  version: "step10-tariff-teaching-v7", year: 2020, market: "USA", tariff_rate: 0.25, policy_year: 2018,
  taxed_rule: { basis: "first-year goods trade surplus with the market (ICIO sectors A-C)", min_million_usd: 1000, year: 2016 },
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
  // One screen: the whole sample first (loading), then the optional example with its selectors; no variable primer.
  expect(html).toContain("关税暴露 X：哪些国家被加税，暴露有多大？");
  expect(html).toContain("正在读取全部国家的关税暴露");
  expect(html.indexOf("全部样本")).toBeLessThan(html.indexOf("跟踪一个例子（可选）"));
  expect(html).not.toContain("模拟");
  expect(html).toContain("国家 A");
  expect(html).toContain("对比国家 B");
  expect(html).toContain("不选对比国家");
  expect(html).toContain("步骤 11–14 会把回归结果换算到你选的例子上");
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
    countries: ["CAN", "CHN", "CRI", "KOR", "MEX", "USA"],
    sectors: ["C26", "C29"],
  };
  const html = renderToStaticMarkup(<ShockLab meta={meta} step={step} state={{
    data: undefined, save: () => {}, complete: false, syncing: false,
    syncError: null, syncNow: () => {},
  }} />);
  expect(html).toContain('<option value="CAN" selected="">CAN 加拿大</option>');
  expect(html).toContain('<option value="CRI" selected="">CRI 哥斯达黎加</option>');
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
  // The worked card says why it does not use the example.
  expect(document.querySelector(".teaching-x-reason")!.textContent).toBe("你的例子 MEX 墨西哥 · C29 汽车及零部件 不在回归样本里，所以这里用 CAN 加拿大 各行业的平均算。");
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
  expect((screen.getByRole("combobox", { name: "对比国家 B" }) as HTMLSelectElement).value).toBe("");
  expect(document.querySelectorAll(".teaching-example-summary li")).toHaveLength(1);
  expect(document.querySelector('[aria-label="所选例子的 X 算例"]')!.textContent).toContain("X = 90.00% × 25% = 22.50 个百分点");
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
  expect(document.querySelector(".teaching-data-note")?.textContent).toContain("由课程按设定生成（参照真实指标的量级）");
  expect(document.body.textContent).toContain("关税暴露 X · 个百分点");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls[0] as unknown[])[0]).toMatchObject({ compared: ["CAN"], teaching_country: "CAN", teaching_year: 2020 });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});


test("the step 10 gap note matches whether the two countries were taxed", () => {
  expect(stepTenGapNote([true, false])).toContain("就是加税那年起的 X");
  expect(stepTenGapNote([true, true])).toContain("差距来自对美出口份额 w 的不同");
  expect(stepTenGapNote([false, false])).toContain("没有差距");
  expect(stepTenGapNote([true])).toBeUndefined();
});

const tenYears = [2016, 2017, 2018, 2019, 2020];
/** The worked X = w × τ for the followed example (the whole-sample card for CAN has another label). */
const WORKED = '[aria-label="所选例子的 X 算例"]';
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
  const meta: Meta = { years: tenYears, countries: ["CAN", "CRI", "USA"], sectors: ["C26", "C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const save = mock(() => {});
  // Nothing saved yet: CAN vs CRI in C29, as the lead text says.
  render(<ShockLab meta={meta} step={step} state={tenState(undefined, save)} />);
  await waitFor(() => expect(series).toHaveBeenCalledWith(["CAN", "CRI"], "C29"));
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C29");
  expect(series).not.toHaveBeenCalledWith(expect.anything(), "C26");
  const lead = document.querySelector(".teaching-example-lead")!.textContent!;
  expect(lead).toContain("两国汽车业都主要出口到美国");
  expect(lead).toContain("行业默认是 C29 汽车及零部件");
  expect(lead).not.toContain("步骤 9");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ teaching_industry: "C29", teaching_example_chosen: false });
  cleanup();
  // A saved step 10 choice keeps leading.
  const kept = mock(() => {});
  const saved = {
    compared: ["CAN", "CRI"], teaching_industry: "C26", teaching_example_chosen: true,
    teaching_observation: { country: "CAN", industry: "C26", year: 2020, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.125, version: "step10-tariff-teaching-v5" },
  };
  render(<ShockLab meta={meta} step={step} state={tenState(saved, kept)} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C26");
  expect(kept).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("both taxed, one with w = 0: the exposed country is worked through and nobody is told to switch", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CHE", "MEX"], sectors: ["B05_06"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "CAN" ? 0.93 : 0, true)));
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CHE", "CAN"], teaching_industry: "B05_06", teaching_example_chosen: true }, save)} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  const worked = document.querySelector(WORKED)!.textContent!;
  expect(worked).toContain("CAN 加拿大 · B05_06");
  expect(worked).toContain("X = 93.00% × 25% = 23.25 个百分点");
  // Both taxed at the same rate: the tail sentence fits here.
  expect(worked).toContain("（税率相同时，对美出口份额 w 不同，X 也不同）");
  const hint = document.querySelector(".teaching-example-hint")!.textContent!;
  expect(hint).toContain("图上 CAN 加拿大 的 X 就是加税带来的暴露");
  expect(hint).not.toContain("换一个行业或国家");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ teaching_country: "CAN" });
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("one taxed and one untaxed: no 税率相同 sentence; a tiny w keeps significant digits", async () => {
  const meta: Meta = { years: tenYears, countries: ["BRN", "CAN", "MEX"], sectors: ["C30"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "BRN" ? 0.000033 : 0.4, country === "BRN")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["BRN", "MEX"], teaching_industry: "C30", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  const worked = document.querySelector(WORKED)!.textContent!;
  expect(worked).toContain("对美出口份额 0.0033%");
  expect(worked).toContain("X = 0.0033% × 25% = 0.00083 个百分点");
  expect(worked).not.toContain("税率相同时");
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
  const strip = () => document.querySelector(".teaching-example-record")!.textContent;
  expect(strip()).toContain("已记录的例子尚未记录");
  await waitFor(() => expect(strip()).toContain("已记录的例子CAN 加拿大 · C29 汽车及零部件（对比 MEX 墨西哥）"));
  expect(strip()).toContain("当前例子已自动记录");
  fireEvent.change(screen.getByRole("combobox", { name: "行业" }), { target: { value: "C26" } });
  await waitFor(() => expect(strip()).toContain("CAN 加拿大 · C26"));
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
  const strip = () => document.querySelector(".teaching-example-record")!.textContent;
  await waitFor(() => expect(strip()).toContain("当前例子就是已记录的材料。"));
  fireEvent.change(screen.getByRole("combobox", { name: "行业" }), { target: { value: "C26" } });
  const button = await screen.findByRole("button", { name: "改用当前例子作为报告材料（之后需在步骤 15 更新报告）" });
  // Browsing after submission does not record: the strip still names the submitted example.
  expect(strip()).toContain("CAN 加拿大 · C29");
  expect(save).not.toHaveBeenCalled();
  button.focus();
  act(() => { fireEvent.click(button); });
  await waitFor(() => expect(strip()).toContain("CAN 加拿大 · C26"));
  expect(strip()).toContain("报告已提交：浏览不再自动改动报告材料。当前例子就是已记录的材料。请到步骤 15 更新报告并重新提交给老师。");
  expect(screen.queryByRole("button", { name: /改用当前例子/ })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".teaching-example-record")));
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
  const summary = document.querySelector(".teaching-example-summary")!.textContent!;
  expect(summary).toContain("2020 年 X = 0 个百分点");
  expect(summary).not.toContain("X = 0.00 个百分点");
  expect(summary).toContain("2020 年 X = 0.00083 个百分点");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("step 10 leads with the whole sample: four tiles from the overview, then the sorted chart with A and B marked", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  await waitFor(() => expect(document.querySelector(".teaching-tiles")).not.toBeNull());
  const tiles = [...document.querySelectorAll(".teaching-tiles li")].map((tile) => tile.textContent);
  // Counts, the taxed rule, the imposer, the rate and the year all come from the response.
  expect(tiles).toEqual(["3 国被美国加税（对美货物顺差 ≥ 10 亿美元）", "2 国未被加税（X 始终为 0）", "USA 美国加征关税的一方（不在样本中）", "25%2018 年起的税率（此前为 0）"]);
  // The scenario is named as US-centred before any number, with the data rule that picks the taxed countries.
  expect(document.querySelector(".teaching-scenario")?.textContent).toMatch(/^情景以美国为中心：USA 美国从 2018 年起对 2016 年对美货物贸易顺差达到或超过 10 亿美元的 3 个国家加征 25% 关税，其余 2 个国家未被加税。/);
  // The rule is restated under the chart.
  expect(document.querySelector(".country-exposure-rule")!.textContent).toBe("被加税的规则来自 ICIO 数据：2016 年对美货物贸易顺差达到或超过 10 亿美元。");
  // The sample sentence is one line: countries, country×industry units and records (rows from teaching-groups).
  expect(document.querySelector(".teaching-one-line")!.textContent).toBe("回归样本：5 国的 210 个国家×行业 × 5 年 = 10 条记录。下图是每个国家 2020 年各行业的平均 X。");
  // The generated-data note stays as one line at the top.
  expect(document.querySelectorAll(".teaching-data-note")).toHaveLength(1);
  expect(document.querySelector(".country-exposure")).not.toBeNull();
  // The default example: CAN (taxed bar) is A, MEX (untaxed code) is B.
  await waitFor(() => expect(document.querySelector('[data-highlight="B"]')?.getAttribute("data-country")).toBe("MEX"));
  expect(document.querySelector('[data-highlight="A"]')!.getAttribute("data-country")).toBe("CAN");
  expect(document.querySelector(".country-exposure-note")!.textContent).toContain("是加征关税的一方，不在样本中");
  // The example section is optional and names CAN as one of the taxed countries, with the count from the data.
  expect(document.body.textContent).toContain("跟踪一个例子（可选）");
  expect(document.querySelector(".teaching-example-lead")!.textContent).toContain("默认的加拿大是 3 个被加税国家之一");
  // What the next four steps do is one line now.
  expect(document.body.textContent).toContain("步骤 11–14 用每个国家×行业的 X 对照四类指标 Y");
  expect(document.body.textContent).not.toContain("后面四步用它做什么");
  expect(document.body.textContent).not.toContain("设定：");
  // Picking another country moves the A mark.
  fireEvent.change(screen.getByRole("combobox", { name: "国家 A" }), { target: { value: "MEX" } });
  await waitFor(() => expect(document.querySelector('[data-highlight="A"]')!.getAttribute("data-country")).toBe("MEX"));
  expect(document.querySelector('[data-highlight="B"]')!.getAttribute("data-country")).toBe("CAN");
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
  expect(document.querySelector(".teaching-scenario")?.textContent).toMatch(/^情景以美国为中心：USA 美国从 2018 年起对 3 个国家的商品加征 25% 关税，其余 2 个国家未被加税。/);
  expect(document.querySelector(".country-exposure-rule")).toBeNull();
  expect(document.body.textContent).not.toContain("对美货物");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("an untaxed example works X = w × τ through CAN's industry mean instead, and says why", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.8, false)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["MEX"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  expect(document.querySelector(WORKED)).toBeNull();
  const card = document.querySelector('[aria-label="被加税国家的 X 算例"]')!.textContent!;
  // CAN's mean X 14.30 pp over 44 industries at τ = 25% means a mean w of 57.20%.
  expect(card).toContain("CAN 加拿大 · 2020 年 · 44 个行业平均");
  expect(card).toContain("X = 57.20% × 25% = 14.30 个百分点");
  expect(card).toContain("你的例子 MEX 墨西哥 未被加税，X 一直是 0，所以这里用 CAN 加拿大 各行业的平均算。");
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("the fallback worked country is CAN, else the most exposed taxed one", () => {
  expect(fallbackWorkedCountry(countriesOverview)).toMatchObject({ country: "CAN", mean_w: 0.572 });
  const withoutCan = { ...countriesOverview, countries: countriesOverview.countries.filter((row) => row.country !== "CAN") };
  expect(fallbackWorkedCountry(withoutCan)?.country).toBe("CRI");
  expect(fallbackWorkedCountry(undefined)).toBeUndefined();
});

test("the whole-sample overview shows a loading line, then an error with a retry that refetches", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  countriesSpy.mockRejectedValueOnce(new Error("boom"));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  expect(screen.getByText("正在读取全部国家的关税暴露…")).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/全部国家的关税暴露读取失败/)).toBeTruthy());
  // The followed example still works while the overview is missing.
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  const alert = screen.getByText(/全部国家的关税暴露读取失败/).closest(".error-box")!;
  fireEvent.click(alert.querySelector("button")!);
  await waitFor(() => expect(document.querySelector(".teaching-tiles")).not.toBeNull());
  expect(countriesSpy).toHaveBeenCalledTimes(2);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("A = USA: the card says why it uses CAN, and the chart marks the recorded example, as the record line names it", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CRI", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  // The USA has no rows in the teaching data.
  const series = tenSeries((countries, industry) => countries.filter((country) => country !== "USA").flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const recorded = {
    compared: ["CAN", "CRI"], teaching_industry: "C29", teaching_example_chosen: true,
    teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.125, version: "step10-tariff-teaching-v5" },
  };
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState(recorded, save)} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  const legend = () => document.querySelector(".country-exposure-legend-example")!.textContent;
  expect(legend()).toBe("AB你跟踪的例子");
  fireEvent.change(screen.getByRole("combobox", { name: "国家 A" }), { target: { value: "USA" } });
  await waitFor(() => expect(document.querySelector(".teaching-x-reason")).not.toBeNull());
  expect(document.querySelector(".teaching-x-reason")!.textContent).toBe(
    "你的例子里的 USA 美国 是加征关税的一方，不在回归样本中，所以这里用 CAN 加拿大 各行业的平均算。",
  );
  // The recorded example is unchanged, and the chart marks it (not the USA, which has no bar).
  expect(document.querySelector(".teaching-example-record")!.textContent).toContain("CAN 加拿大 · C29 汽车及零部件（对比 CRI 哥斯达黎加）");
  expect(document.querySelector('[data-highlight="A"]')!.getAttribute("data-country")).toBe("CAN");
  expect(document.querySelector('[data-highlight="B"]')!.getAttribute("data-country")).toBe("CRI");
  expect(legend()).toBe("AB已记录的例子（当前选择不在回归样本中）");
  expect(save).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("while the example loads, the CAN card says so rather than switching silently", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CRI", "USA"], sectors: ["C29"] };
  const groups = tenGroups();
  const series = spyOn(api, "teachingSeries").mockImplementation(() => new Promise(() => {}));
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} />);
  await waitFor(() => expect(document.querySelector(".teaching-x-reason")?.textContent).toBe(
    "你的例子的关税数据还在读取，所以这里用 CAN 加拿大 各行业的平均算。",
  ));
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("before anything is recorded, a marked country with no bar is named in the legend", () => {
  try {
    render(<CountryExposureChart data={countriesOverview} highlight={["USA", "CRI"]} />);
    expect(document.querySelector('[data-highlight="A"]')).toBeNull();
    expect(document.querySelector(".country-exposure-legend-example")!.textContent).toBe("AB你跟踪的例子；A = USA 美国 不在图上");
  } finally {
    cleanup();
  }
});

test("A taxed with w = 0 and B taxed: the card works B through and says why", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "ISR", "MEX"], sectors: ["B05_06"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "ISR" ? 0 : 0.3, true)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["ISR", "MEX"], teaching_industry: "B05_06", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  const worked = document.querySelector(WORKED)!;
  expect(worked.textContent).toContain("MEX 墨西哥 · B05_06");
  expect(worked.querySelector(".teaching-x-reason")!.textContent).toBe(
    "国家 A ISR 以色列 被加税，但该行业首年不向美国出口（w = 0），X 一直是 0，所以这里用对比国家 B MEX 墨西哥 算。",
  );
  cleanup();
  series.mockRestore();
  // An untaxed A says so too.
  const untaxedA = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.3, country === "MEX")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CAN", "MEX"], teaching_industry: "B05_06", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  expect(document.querySelector(`${WORKED} .teaching-x-reason`)!.textContent).toBe("国家 A CAN 加拿大 未被加税，X 一直是 0，所以这里用对比国家 B MEX 墨西哥 算。");
  cleanup();
  // An example worked through as A gets no such line.
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["MEX", "CAN"], teaching_industry: "B05_06", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(WORKED)).not.toBeNull());
  expect(document.querySelector(`${WORKED} .teaching-x-reason`)).toBeNull();
  groups.mockRestore();
  untaxedA.mockRestore();
  cleanup();
});

test("two countries not in the sample: plural wording, and the card says why it uses CAN", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CHN", "MEX"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries
    .filter(() => industry !== "O")
    .flatMap((country) => tenRows(country, industry, 0.5, true)));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CHN", "MEX"], teaching_industry: "O", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".reg-boundary[role=status]")).not.toBeNull());
  expect(document.querySelector(".reg-boundary[role=status]")!.textContent).toBe(
    "CHN 中国、MEX 墨西哥 · O 公共管理与国防 不在回归样本里：这两个国家的这个行业在首年（2016 年）都缺少必要数据，回归没有用到它们。请换国家或行业。",
  );
  expect(document.querySelector(".teaching-x-reason")!.textContent).toBe(
    "你的例子 CHN 中国、MEX 墨西哥 · O 公共管理与国防 不在回归样本里，所以这里用 CAN 加拿大 各行业的平均算。",
  );
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

test("a small X reads with the digits that check, in the X card and the trend card", async () => {
  const meta: Meta = { years: tenYears, countries: ["CHN", "CRI", "MEX"], sectors: ["B05_06"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, country === "CHN" ? 0.000985 : 0.3, country === "CHN")));
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["CHN", "CRI"], teaching_industry: "B05_06", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelector(".teaching-example-summary")).not.toBeNull());
  expect(document.querySelector(WORKED)!.textContent).toContain("X = 0.10% × 25% = 0.025 个百分点");
  expect(document.querySelector(".teaching-example-summary")!.textContent).toContain("w = 0.10%，2020 年 X = 0.025 个百分点");
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
  fireEvent.change(screen.getByRole("combobox", { name: "国家 A" }), { target: { value: "USA" } });
  await waitFor(() => expect(document.querySelector('[aria-label="已记录例子的 X 算例"]')).not.toBeNull());
  // One note under the selects: the imposer, what to do, and what is shown instead.
  const notes = document.querySelectorAll(".reg-boundary");
  expect(notes).toHaveLength(1);
  expect(notes[0].textContent).toBe(
    "美国是加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义（w 是“对美出口份额”，美国不会向自己出口），不是数据缺失，不能作为例子。请换一个国家。下面仍显示已记录的例子 CAN 加拿大 · C29 汽车及零部件（对比 MEX 墨西哥）。",
  );
  expect(document.body.textContent).not.toContain("见上面的说明");
  const worked = document.querySelector('[aria-label="已记录例子的 X 算例"]')!.textContent!;
  expect(worked).toContain("CAN 加拿大 · C29 汽车及零部件 · 2020 年");
  expect(worked).toContain("X = 93.00% × 25% = 23.25 个百分点");
  expect(document.body.textContent).not.toContain("各行业的平均算");
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
  await waitFor(() => expect(document.querySelector('[aria-label="已记录例子的 X 算例"]')).not.toBeNull());
  const notes = document.querySelectorAll(".reg-boundary");
  expect(notes).toHaveLength(1);
  expect(notes[0].textContent).toMatch(/^ISR 以色列 · D .* 不在回归样本里：这个国家的这个行业在首年（2016 年）缺少必要数据，回归没有用到它。请换一个国家或行业。下面仍显示已记录的例子 ISR 以色列 · S /);
  expect(document.querySelector('[aria-label="已记录例子的 X 算例"]')!.textContent).toContain("ISR 以色列 · S");
  expect(document.body.textContent).not.toContain("各行业的平均算");
  expect(document.body.textContent).toContain("已记录的例子 · 五年趋势");
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
  const svg = document.querySelector('[data-mark-year="2018"]')!.closest("svg")!;
  const marker = Number(svg.querySelector('[data-mark-year="2018"] line')!.getAttribute("x1"));
  const dots = [...svg.querySelectorAll('[data-series-group="CAN"] circle')].map((dot) => Number(dot.getAttribute("cx")));
  expect(marker).toBeGreaterThan(dots[1]);
  expect(marker).toBeLessThan(dots[2]);
  expect(marker).toBeCloseTo((dots[1] + dots[2]) / 2);
  // The lead names the year X rises from 0.
  expect(document.body.textContent).toContain("看 X 从 2018 年起怎样从 0 上升。");
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
  await waitFor(() => expect(document.querySelectorAll(".bounded-data-table tbody tr").length).toBe(5));
  const wCells = [...document.querySelectorAll(".bounded-data-table tbody tr")].map((tr) => tr.children[3]?.textContent);
  expect(new Set(wCells).size).toBe(1);
  groups.mockRestore(); series.mockRestore();
});

test("step 10 逐年读数 lists country A first, then B", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX"], sectors: ["C29"] };
  const groups = tenGroups();
  // The server sends the rows in alphabetical order.
  const series = tenSeries((_countries, industry) => [...tenRows("CAN", industry, 0.93, true), ...tenRows("MEX", industry, 0.4, false)]);
  render(<ShockLab meta={meta} step={step} state={tenState({ compared: ["MEX", "CAN"], teaching_industry: "C29", teaching_example_chosen: true })} />);
  await waitFor(() => expect(document.querySelectorAll(".bounded-data-table tbody tr").length).toBe(10));
  const firstCells = [...document.querySelectorAll(".bounded-data-table tbody tr")].map((tr) => tr.children[0]?.textContent);
  expect(firstCells.slice(0, 5).every((name) => name === "MEX 墨西哥")).toBe(true);
  expect(firstCells.slice(5).every((name) => name === "CAN 加拿大")).toBe(true);
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("after the report is submitted, an unconfirmed step 10 selection is kept as browsing state", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "CRI", "MEX"], sectors: ["C29", "C26"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const views: unknown[] = [];
  const locked = { ...tenState(RECORDED_CAN, mock(() => {}), true), saveView: (patch: unknown) => views.push(patch) };
  const first = render(<ShockLab meta={meta} step={step} state={locked} />);
  fireEvent.change(screen.getByRole("combobox", { name: "对比国家 B" }), { target: { value: "CRI" } });
  await waitFor(() => expect(views.at(-1)).toEqual({ browse_selection: { first: "CAN", second: "CRI", industry: "C29" } }));
  first.unmount();
  // Coming back: the selection on screen is the browsed one; the recorded example (CAN vs MEX) is unchanged.
  const save = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ ...RECORDED_CAN, browse_selection: { first: "CAN", second: "CRI", industry: "C29" } }, save, true)} />);
  expect((screen.getByRole("combobox", { name: "对比国家 B" }) as HTMLSelectElement).value).toBe("CRI");
  await waitFor(() => expect(document.querySelector(".teaching-example-record")!.textContent).toContain("对比 MEX 墨西哥"));
  expect(save).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});
