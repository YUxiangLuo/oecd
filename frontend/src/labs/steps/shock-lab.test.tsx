import { expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, Step } from "../../types";
import { exampleWasChosen, representativeRow, ShockLab, stepTenGapNote } from "./shock-lab";
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
  expect(html).toContain("正在读取关税数据");
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
  await waitFor(() => expect(screen.getByText(/不在回归样本里/)).toBeTruthy());
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
  await waitFor(() => expect(screen.getByText(/CAN 加拿大 · C29 汽车及零部件 不在回归样本里/)).toBeTruthy());
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
  expect(Number(markLabel.getAttribute("x"))).toBeLessThan(marker);
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

test("a step 10 that was only flashed still follows a later one-industry step 9 choice", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C26", "C29"] };
  const groups = tenGroups();
  const series = tenSeries((countries, industry) => countries.flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const save = mock(() => {});
  // The default example, auto-saved when step 10 was clicked through (never picked).
  const flashed = {
    compared: ["CAN", "MEX"], teaching_industry: "C29", teaching_example_chosen: false,
    teaching_observation: { country: "CAN", industry: "C29", year: 2020, teaching_export_share_w: 0.5, teaching_tariff_rate_tau: 0.25, teaching_tariff_exposure: 0.125, version: "step10-tariff-teaching-v5" },
  };
  const stepNine = { observations: [{ industry: "C26" }, { industry: "C26" }] };
  const getStep = (<T,>(n: number) => (n === 9 ? stepNine : undefined) as T | undefined);
  render(<ShockLab meta={meta} step={step} state={tenState(flashed, save)} getStep={getStep} />);
  await waitFor(() => expect(series).toHaveBeenCalledWith(["CAN", "MEX"], "C26"));
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C26");
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect((save.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ teaching_industry: "C26", teaching_example_chosen: false });
  cleanup();
  // An example the student picked here keeps leading.
  const kept = mock(() => {});
  render(<ShockLab meta={meta} step={step} state={tenState({ ...flashed, teaching_example_chosen: true }, kept)} getStep={getStep} />);
  await waitFor(() => expect(screen.getByText(/算一次/)).toBeTruthy());
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C29");
  expect(kept).not.toHaveBeenCalled();
  groups.mockRestore();
  series.mockRestore();
  cleanup();
});

test("a step 9 industry that the example pair lacks falls back to the default, and says why", async () => {
  const meta: Meta = { years: tenYears, countries: ["CAN", "MEX", "USA"], sectors: ["C29", "O"] };
  const groups = tenGroups();
  // MEX·O is not in the regression sample.
  const series = tenSeries((countries, industry) => countries
    .filter((country) => industry !== "O" || country !== "MEX")
    .flatMap((country) => tenRows(country, industry, 0.5, country === "CAN")));
  const getStep = (<T,>(n: number) => (n === 9 ? { observations: [{ industry: "O" }] } : undefined) as T | undefined);
  render(<ShockLab meta={meta} step={step} state={tenState(undefined)} getStep={getStep} />);
  await waitFor(() => expect(document.querySelector(".teaching-fallback-note")).not.toBeNull());
  expect(document.querySelector(".teaching-fallback-note")!.textContent).toBe(
    "步骤 9 看的是 O 公共管理与国防，但 MEX 墨西哥 的这个行业不在回归样本里，所以这里先用默认的 C29 汽车及零部件；也可以在下面换行业或国家。",
  );
  expect((screen.getByRole("combobox", { name: "行业" }) as HTMLSelectElement).value).toBe("C29");
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
  await waitFor(() => expect(screen.getByText(/算一次/)).toBeTruthy());
  const worked = document.querySelector('[aria-label="用所选例子算一次 X"]')!.textContent!;
  expect(worked).toContain("CAN 加拿大 · B05_06");
  expect(worked).toContain("X = 93.00% × 25% = 23.25 个百分点");
  // Both taxed at the same rate: the tail sentence fits here.
  expect(worked).toContain("税率相同时，对美出口份额 w 不同，X 也不同。");
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
  await waitFor(() => expect(screen.getByText(/算一次/)).toBeTruthy());
  const worked = document.querySelector('[aria-label="用所选例子算一次 X"]')!.textContent!;
  expect(worked).toContain("w = 0.0033%");
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
