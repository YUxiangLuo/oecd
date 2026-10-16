import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import { pendingStepTenExample, RegressionRequestError, RegressionRunLab } from "./regression";
import {
  barPreviewText, degreeIdentity, parallelTrendsNote, familyBarRows, forwardShareIdentity, tradeShareIdentity, GROUP_CHART_CAPTION, groupLines, waveMarkers,
} from "./regression-step/family-bars";
import { exampleEffect, lagSplit, RegressionResultCard } from "./regression-step/result-card";
import { equationSymbol } from "./regression-step/model-equation";
import { TEACHING_MODEL_VERSION } from "./regression-step/saved-run";
import { INTERRUPTED_RUN_NOTE } from "./regression-step/use-regression-run";
import { scrollIntoCourseContent } from "./content-scroll";
import { groupedFixed } from "./format";
import type {
  RegressionOutcome, Step, StepStateApi, TeachingEstimate, TeachingGroupsResponse, TeachingOverviewResponse, TeachingPanelResponse,
} from "./types";
import { GENERATED_DATA_NOTE, GENERATED_Y_DISCLOSURE } from "./regression-lessons";
import { networkDigits, shownPerPoint } from "./regression-verdict";
import workbenchOptions from "./regression-workbench-options.fixture.json";

afterEach(() => { cleanup(); mock.restore(); });

const step: Step = {
  n: 11, stage: 4, lab: "reg", regression_outcome: "trade", status: "demo", title: "贸易流回归：关税与外国增加值项占比",
  goal: "", tasks: ["一", "二"], concept: "", tip: "", deps: [],
  handoff: { input: "", action: "", output: "" },
};
const state: StepStateApi = {
  data: undefined, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {},
};
const meta = { countries: ["CAN", "MEX", "USA"], sectors: ["C29"] };
const series = (taxed: number, from = 2) => [2016, 2017, 2018, 2019, 2020].map((year, index) => ({ year, change: index < from ? 0 : taxed }));
// Two waves (2018, 2019) and the untaxed.
const waves = (taxed: number, untaxed: number) => ({
  first: series(taxed), second: series(taxed / 2, 3), untaxed: series(untaxed),
});
const groups: TeachingGroupsResponse = {
  version: "v", years: [2016, 2017, 2018, 2019, 2020], policy_year: 2018, policy_years: [2018, 2019],
  sample: {
    rows: 16000, entities: 3200, countries: 75, industries: 44, taxed_countries: 37, untaxed_countries: 38,
    first_wave_countries: 14, second_wave_countries: 23,
  },
  industries: ["C29"],
  outcomes: {
    trade: waves(-0.004, 0.003),
    production: waves(-0.003, 0.002),
    length: waves(-0.01, 0.01),
    network: waves(-40, 30),
  },
  baselines: {
    trade: [
      { key: "FVA_share", label: "外国增加值项占比", kind: "share", unit: "比例（展示为百分点）", default: true, column: "teaching_y_trade", source: "FVA_share" },
      { key: "DVAex_share", label: "国内增加值出口占比", kind: "share", unit: "比例（展示为百分点）", default: false, column: "teaching_y_trade_DVAex_share", source: "DVAex_share" },
    ],
    production: [], length: [], network: [],
  },
  series: {
    trade: { FVA_share: waves(-0.004, 0.003), DVAex_share: waves(0.004, -0.003) },
    production: {}, length: {}, network: {},
  },
};
const estimate = (key: string, label: string, coef: number, low: number, high: number, extra: Partial<TeachingEstimate> = {}): TeachingEstimate => ({
  key, label, kind: "share", default: false, coef, ci_low: low, ci_high: high, p: 0.001, status: "ok",
  suppress_inference: false, depvar_std: 0.1, depvar_within_std: 0.1, depvar_mean: 0.3, n_obs: 16000, ...extra,
});
const overview: TeachingOverviewResponse = {
  version: "v", disclaimer: "",
  outcomes: {
    trade: [
      estimate("FVA_share", "外国增加值项占比", -0.5493, -0.5711, -0.5274, { default: true }),
      estimate("DVAex_share", "国内增加值出口占比", 0.5561, 0.535, 0.577),
    ],
    production: [], length: [], network: [],
  },
};
const savedRun = (baseline: string, label: string, coef = 0.5, low = 0.4, high = 0.6) => ({
  design: {
    outcome: "trade", baseline, baseline_label: label, depvar: `teaching_y_trade_${baseline}`, depvar_label: label,
    depvar_kind: "share", depvar_unit: "比例（展示为百分点）", granularity: "country_industry", shock_type: "tariff",
    shock_col: "teaching_tariff_exposure", treated_col: "teaching_treated", method: "twfe_intensity", control_mode: "none",
    interaction: false, price_mode: "nominal", scenario: "clean", scenario_label: "基准", sample_filter: "排除 ROW",
    exclude_row: true, controls: [], control_labels: {}, equation: "y = x", equation_parts: [], panel_file: "panel_teaching.csv",
    entity: "entity_id", cluster: "country",
  },
  result: {
    depvar: `teaching_y_trade_${baseline}`, n_obs: 100, n_entities: 20, n_times: 5, n_clusters: 10, r2_within: 0.2,
    depvar_mean: 0.3, depvar_std: 0.1, depvar_within_std: 0.1, diagnostics: { study_contract: "economics-v2" }, notes: [], status: "ok", status_reasons: [],
    coefs: [{ name: "teaching_tariff_exposure", coef, se: 0.05, t: 10, p: 0.001, stars: "***", ci_low: low, ci_high: high }],
    support: { treated_clusters: 10, untreated_clusters: 0, treated_entities: 20, untreated_entities: 0, total_entities: 20, reversal_entities: [], reversal_share: 0, absorbing: true, status: "ok", reasons: [], min_treated_clusters: 5, max_reversal_share: 0, suppress_inference: false },
  },
  disclaimer: "教学模拟",
  model_snapshot: { version: TEACHING_MODEL_VERSION, x_columns: ["teaching_tariff_exposure"], y_column: `teaching_y_trade_${baseline}`, baseline, entity: "entity_id", time: "year", fixed_effects: ["entity_id", "year"], controls: [], interactions: [], seed: 1, beta: 0.55, tariff_path: [], disclaimer: "教学" },
  variable_catalog: [],
});
const FVA = () => savedRun("FVA_share", "外国增加值项占比", -0.5493, -0.5711, -0.5274);
/** The two bars as read aloud: the value with its unit and the 95% interval. */
const FVA_BAR = "外国增加值项占比：-0.55 个百分点，95% 区间 [-0.57, -0.53]";
const DVA_BAR = "国内增加值出口占比：+0.56 个百分点，95% 区间 [+0.54, +0.58]";
const DVA = () => savedRun("DVAex_share", "国内增加值出口占比", 0.5561, 0.535, 0.577);
const benchmark = { backend: "x", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "x", notes: [] };
const mockApis = () => {
  spyOn(api, "teachingGroups").mockResolvedValue(groups);
  // The default model is shown before the run (the server's design) and the change-the-model section is open.
  spyOn(api, "regressionDesign").mockImplementation(async () => FVA().design as never);
  spyOn(api, "regressionOptions").mockResolvedValue(workbenchOptions as never);
  spyOn(api, "teachingSeries").mockResolvedValue({ version: "v", disclaimer: "", rows: [], total: 0, years: [] } as TeachingPanelResponse);
  return spyOn(api, "teachingOverview").mockResolvedValue(overview);
};

describe("simple regression workbench", () => {
  test("before data arrives: one action, no Y dropdown, no step focus, no exercises or folds", () => {
    for (const outcome of ["trade", "production", "length", "network"] as RegressionOutcome[]) {
      const html = renderToStaticMarkup(<RegressionRunLab step={{ ...step, regression_outcome: outcome }} meta={meta} state={state} />);
      const dom = new DOMParser().parseFromString(html, "text/html");
      expect(dom.querySelectorAll(".reg-run-card > button")).toHaveLength(1);
      expect(dom.querySelector(".reg-run-card h3")?.textContent).toContain("关税暴露（X）");
      expect(dom.body.textContent).not.toContain("模拟");
      expect(dom.body.textContent).not.toContain("teaching_tariff_exposure");
      expect(html).not.toMatch(/本步重点|方法与步骤 11 相同|结果指标 Y/);
      expect(dom.querySelectorAll("select, details, table")).toHaveLength(0);
      expect(html).not.toMatch(/五年示例|可选趋势对照|可选小练习|四步结果汇总|计算方法说明|先用眼睛看/);
    }
  });

  test("shows the taxed vs untaxed comparison before the run and names the full sample on the button", async () => {
    const overviewCall = mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={state} />);
    const figure = await screen.findByRole("img", { name: /加税前后：各组外国增加值项占比的平均变化/ });
    expect(figure.getAttribute("aria-label")).toContain("2018 年第一批加税，2019 年第二批加税");
    expect(figure.textContent).toContain("第一批被加税");
    expect(figure.textContent).toContain("第二批被加税");
    expect(figure.textContent).toContain("未被加税");
    await waitFor(() => expect(screen.getByRole("button", { name: "计算贸易流回归（用全部 16,000 条记录）" })).toBeTruthy());
    expect(api.teachingSeries).toHaveBeenCalledWith(["CAN", "MEX"], "C29");
    // No bars and no reading cards before the run; the generated-data note is said already.
    expect(overviewCall).not.toHaveBeenCalled();
    expect(document.querySelector(".diverging-bars")).toBeNull();
    expect(document.body.textContent).not.toContain("回归要算的");
    expect(document.querySelector(".reg-data-note-before")?.textContent).toBe(GENERATED_DATA_NOTE);
  });

  test("one run saves the default Y and draws one bar per Y; clicking another bar previews it and saves nothing", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockImplementation(async () => ({ ...FVA(), benchmark }) as never);
    const saves: Record<string, unknown>[] = [];
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, save: (patch) => { saves.push(patch); } }} />);
    fireEvent.click(await screen.findByRole("button", { name: /^计算贸易流回归/ }));
    await waitFor(() => expect(document.querySelectorAll("[data-bar]")).toHaveLength(2));
    expect(run.mock.calls[0][2]).toBeNull();
    expect(saves).toHaveLength(1);
    expect((saves[0].run as { design: { baseline: string } }).design.baseline).toBe("FVA_share");
    // The run travels with its one-sentence label, which step 15 repeats; nothing else is saved.
    expect(saves[0]).toEqual({ run: expect.anything(), material_label: expect.any(String) });
    expect(saves[0].material_label).toMatch(/^默认模型：外国增加值项占比两年累计 /);
    // The shared card sits after the result and the optional change-the-model fold, before the quiz, saying what 计算
    // saved; with no model experiment put into the report it names none.
    const material = document.getElementById("step-material-action")!;
    expect(material.className).toContain("material-card--recorded");
    expect(material.querySelector(".material-card-summary")?.textContent).toBe("默认模型：外国增加值项占比（已计算）");
    expect(material.querySelector(".material-card-extra")).toBeNull();
    expect(material.querySelector(".material-card-how")?.textContent).toBe("计算后自动保存，无需另外操作。");
    expect(material.compareDocumentPosition(document.querySelector(".verdict-card")!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(material.compareDocumentPosition(document.querySelector("details.reg-custom-section")!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // The saved Y is said in its bar's name (the bars are not toggles).
    const saved = screen.getAllByRole("button").filter((node) => node.getAttribute("aria-label")?.endsWith("，已保存"));
    expect(saved).toHaveLength(1);
    expect(saved[0].getAttribute("aria-label")).toBe(`${FVA_BAR}，已保存`);
    // The saved bar's label is the headline's number.
    expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("外国增加值项占比平均低 0.55 个百分点");
    // The result card opens with the generated-data disclosure, before the headline.
    const card = document.querySelector(".verdict-card")!;
    expect(card.firstElementChild?.textContent).toBe(GENERATED_Y_DISCLOSURE);
    expect(card.textContent?.split(GENERATED_DATA_NOTE)).toHaveLength(1);
    expect(screen.getByRole("group", { name: /X 每高 1 个百分点，Y 两年累计平均相差（个百分点）/ })).toBeTruthy();
    // Two sections: the data, then the default model (said above its run button); the change-the-model card is a
    // folded details after them.
    expect([...document.querySelectorAll(".reg-workbench > section > .reg-section-step")].map((node) => node.textContent))
      .toEqual(["先看数据", "默认模型"]);
    expect(document.querySelector("details.reg-custom-section")!.hasAttribute("open")).toBe(false);
    // Folded: the chart's per-year table and how to read it, the model's terms (open on step 11) and data facts,
    // then the whole change-the-model card.
    await waitFor(() => expect([...document.querySelectorAll("details > summary")].map((node) => node.textContent))
      .toEqual(["各组逐年读数", "这张图怎么读", "公式里各项的意思", "数据、样本和区间的算法", "改模型、对比（选做），换一种模型试试：每次改一处，和默认模型比较"]));
    expect(document.querySelector(".reg-model-terms")!.hasAttribute("open")).toBe(true);
    // Another bar: its reading under the bars, no run, no save, and the headline stays the default Y.
    fireEvent.click(screen.getByRole("button", { name: DVA_BAR }));
    await waitFor(() => expect(document.querySelector(".diverging-bars .reg-bar-preview")?.textContent)
      .toBe(`预览 · ${DVA_BAR}。本步的结论和报告材料仍是外国增加值项占比。`));
    expect(run).toHaveBeenCalledTimes(1);
    expect(saves).toHaveLength(1);
    expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("外国增加值项占比平均低 0.55 个百分点");
    expect(screen.getByRole("button", { name: `${FVA_BAR}，已保存` })).toBeTruthy();
    // The saved bar withdraws the preview.
    fireEvent.click(screen.getByRole("button", { name: `${FVA_BAR}，已保存` }));
    expect(document.querySelector(".reg-bar-preview")).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("while a run is in flight the bars cannot be selected", async () => {
    mockApis();
    let finish: (value: unknown) => void = () => {};
    const run = spyOn(api, "runRegression").mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const other = await screen.findByRole("button", { name: DVA_BAR });
    fireEvent.click(await screen.findByRole("button", { name: "重新计算贸易流回归" }));
    await waitFor(() => expect(other.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(other);
    fireEvent.keyDown(other, { key: "Enter" });
    expect(document.querySelector(".reg-bar-preview")).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    finish({ ...FVA(), benchmark });
    await waitFor(() => expect(document.querySelector('[data-bar="DVAex_share"]')?.getAttribute("aria-disabled")).toBeNull());
  });

  test("restores the saved run on refresh; never starts from the matching step 6-9 indicator", async () => {
    mockApis();
    const saved = {
      ...savedRun("FVA_share", "外国增加值项占比", -0.5, -0.6, -0.4),
      decomposition: { group: "first", wave_start: 2018, year: 2020, pre_years: [2016, 2017], observed: -0.084, remainder: -0.025,
        terms: [{ name: "x_terms", label: "关税 X", change: -0.016 }, { name: "teaching_exchange_rate_change", label: "汇率变动", change: -0.043 }] },
    };
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: saved } as never }} />);
    await waitFor(() => expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("外国增加值项占比平均低 0.50 个百分点"));
    // The sentence under the chart comes back with the saved run (it is saved with it), not only after a fresh run.
    expect([...document.querySelectorAll(".reg-decomposition li")].map((item) => item.textContent)).toEqual(
      ["与关税 X 相关 -1.6 个百分点", "与汇率变动同步 -4.3 个百分点", "其余（各年共同的变化与噪声） -2.5 个百分点"]);
    // The part the headline's estimate is about is marked.
    expect(document.querySelector(".reg-decomposition-tariff")?.textContent).toBe("与关税 X 相关 -1.6 个百分点");
    // The saved run, not the overview, is the selected bar: page and report agree.
    await screen.findByRole("button", { name: "外国增加值项占比：-0.50 个百分点，95% 区间 [-0.60, -0.40]，已保存" });
    expect(document.body.textContent).not.toContain("教学模拟");
    cleanup();
    cleanup();
    const getStep = ((n: number) => n === 6 ? { indicator_selection: { metric: "DVAex_share" } } : undefined) as <T>(step: number) => T | undefined;
    const run = spyOn(api, "runRegression").mockResolvedValue({ ...FVA(), benchmark } as never);
    render(<RegressionRunLab step={step} meta={meta} state={state} getStep={getStep} />);
    expect(screen.getByRole("heading", { name: /外国增加值项占比（Y）/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^计算贸易流回归/ }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0][2]).toBeNull();
  });

  test("the default model is said above the run button before any result, and the change-the-model section opens after it", async () => {
    mockApis();
    // The server's v10 design: X, L1.X and the exchange rate.
    spyOn(api, "regressionDesign").mockResolvedValue({
      ...FVA().design,
      spec: { x_lags: [0, 1], controls: [{ name: "teaching_exchange_rate_change", lag: 0 }], fixed_effects: ["country_industry", "year"] },
      control_labels: { teaching_exchange_rate_change: "汇率变动" },
    } as never);
    render(<RegressionRunLab step={step} meta={meta} state={state} />);
    const model = await screen.findByRole("group", { name: "本步计算的公式" });
    const section = model.closest("section")!;
    expect(section.querySelector(".reg-section-step")?.textContent).toBe("默认模型");
    expect(section.querySelector(".model-eq-terms")?.textContent).toContain("两者之和是两年累计关联");
    expect(section.querySelector(".model-eq-terms")?.textContent).toContain("γ·汇率变动");
    // The model comes before its run button, and nothing of the change-the-model section shows before a result.
    expect(model.compareDocumentPosition(screen.getByRole("button", { name: /计算贸易流回归/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".reg-custom-section")).toBeNull();
    cleanup();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    await screen.findByText("换一种模型试试：每次改一处，和默认模型比较");
    // Folded until opened: nothing of the workbench (its options are not even requested) shows before that.
    const workbench = document.querySelector<HTMLDetailsElement>("details.reg-custom-section")!;
    expect(workbench.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("group", { name: "预设实验" })).toBeNull();
    expect(screen.getByRole("link", { name: "查看结果" }).getAttribute("href")).toBe("#regression-results");
    expect(screen.getByRole("link", { name: "改模型、对比（选做）" }).getAttribute("href")).toBe("#regression-model");
    const summary = workbench.querySelector("summary")!;
    const scroll = spyOn(summary, "scrollIntoView").mockImplementation(() => {});
    const shortcut = screen.getByRole("link", { name: "改模型、对比（选做）" });
    fireEvent.click(shortcut);
    // The default settings are already the first column: the form's button says so.
    expect(await screen.findByRole("group", { name: "预设实验" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "已算好（结果在下面）" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(workbench.open).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    shortcut.focus();
    fireEvent.click(shortcut);
    expect(document.activeElement).toBe(summary);
    expect(workbench.open).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(2);
    // Two ways to change the model: the presets (their tiers one level below), then the custom form.
    expect(screen.getByRole("heading", { level: 4, name: /^方式一：点一个预设实验/ }).className).toBe("reg-custom-way");
    expect(screen.getByRole("heading", { level: 5, name: "必看" }).className).toBe("reg-preset-tier-title");
    expect(screen.getByRole("heading", { level: 5, name: "进阶" }).className).toBe("reg-preset-tier-title");
    expect(workbench.querySelector(".reg-custom-form-details > summary")?.textContent).toMatch(/^方式二：自己改设定/);
    // The single-model table (the Stata/Excel-like one the course asked for) is open from the start.
    expect(screen.getByRole("group", { name: "单模型详细数字" }).hasAttribute("open")).toBe(true);
    expect([...document.querySelectorAll(".reg-custom-compare-table thead th")].map((cell) => cell.textContent)).toEqual(["变量", "默认模型"]);
  });

  test("a saved result makes recalculating secondary, and a failed recalculation labels the old result", async () => {
    mockApis();
    spyOn(api, "runRegression").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, materialLocked: true, data: { run: FVA() } as never }} />);
    const rerun = await screen.findByRole("button", { name: "重新计算贸易流回归" });
    expect(rerun.className).toBe("run-btn secondary");
    // The same model gives the same numbers: a submitted report needs no warning on this page.
    expect(document.querySelector(".reg-rerun-warning")).toBeNull();
    fireEvent.click(rerun);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("贸易流回归未完成：网络连接中断，请检查连接后重试。");
    // The run button is the one retry action; the old result stays, said to be the last saved one.
    expect(screen.getByRole("button", { name: "重试：计算贸易流回归" }).className).toBe("run-btn");
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("这次计算没有成功；下面仍是上次保存的结果。");
    expect(document.querySelector(".reg-results-stale .reg-plain-verdict")).not.toBeNull();
  });

  test("the 加税前后 chart draws the two waves and the untaxed, marks both tariff years and has no estimate bracket", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    await screen.findByRole("img", { name: /加税前后/ });
    expect([...document.querySelectorAll("[data-line]")].map((node) => node.getAttribute("data-line"))).toEqual(["first", "second", "untaxed"]);
    expect([...document.querySelectorAll("[data-marker] text")].map((node) => node.textContent)).toEqual(["2018 年第一批加税", "2019 年第二批加税"]);
    // The raw gaps mix the tariff with what else changed: no bracket claims the regression's gap on the chart.
    expect(document.querySelector("[data-estimate-label]")).toBeNull();
    expect(document.querySelector(".reg-group-figure .reg-gap-caption")?.textContent).toStartWith(GROUP_CHART_CAPTION);
    expect(GROUP_CHART_CAPTION).not.toMatch(/高估|低估|汇率.*(高|低)/);
  });

  test("before the run the chart and its caption are there too, with the premise for every group", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={state} />);
    await screen.findByRole("img", { name: /加税前后/ });
    // One note under the chart: what it mixes in, then the premise.
    expect(document.querySelector(".reg-gap-caption")?.textContent).toStartWith(GROUP_CHART_CAPTION);
    expect(document.querySelector(".reg-gap-caption")?.textContent).toContain("如果没有关税，扣掉汇率等同期变化后，各组的走势应大致平行");
    expect(document.querySelector(".reg-parallel-note")).toBeNull();
  });

  test("each wave gets its line and marker; a group with no country gets no line", () => {
    expect(groupLines({ first: series(-1), second: [], untaxed: series(1) }).map((line) => line.label)).toEqual(["第一批被加税", "未被加税"]);
    expect(waveMarkers([2018])).toEqual([{ year: 2018, label: "2018 年起加税" }]);
    expect(waveMarkers([2018, 2019]).map((marker) => marker.label)).toEqual(["2018 年第一批加税", "2019 年第二批加税"]);
    // The second wave is drawn dashed, so the two waves never differ by colour alone.
    expect(groupLines(waves(-1, 1)).find((line) => line.key === "second")?.dashed).toBe(true);
  });

  test("the saved bar's tooltip says it is saved; the others say what a click does", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const saved = await screen.findByRole("button", { name: `${FVA_BAR}，已保存` });
    const tip = () => document.querySelector(".diverging-bars > div[style*='pointer-events']")?.textContent ?? "";
    fireEvent.mouseEnter(saved, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("状态 · 已保存（本步的结论和报告用这个 Y）");
    expect(tip()).not.toContain("点击");
    fireEvent.mouseEnter(screen.getByRole("button", { name: DVA_BAR }), { clientX: 10, clientY: 10 });
    expect(tip()).toContain("操作 · 点击查看这个 Y 的读数（不改变报告材料）");
  });

  test("step 12's identity line sits inside the chart card, under the drawing", async () => {
    spyOn(api, "teachingGroups").mockResolvedValue(groups);
    spyOn(api, "teachingSeries").mockResolvedValue({ version: "v", disclaimer: "", rows: [], total: 0, years: [] } as TeachingPanelResponse);
    spyOn(api, "teachingOverview").mockResolvedValue({ ...overview, outcomes: { ...overview.outcomes, production: [
      estimate("3b_VA_GVC_C_share", "复杂 GVC 生产份额", -0.3756, -0.39, -0.36, { default: true }),
      estimate("2_VA_RT_share", "传统贸易生产份额", -0.2950, -0.31, -0.28),
      estimate("3a_VA_GVC_S_share", "简单 GVC 生产份额", -0.3045, -0.32, -0.29),
      estimate("1_VA_D_share", "纯国内生产份额", 0.9752, 0.95, 1.0),
    ] } });
    const run = savedRun("3b_VA_GVC_C_share", "复杂 GVC 生产份额", -0.3756, -0.39, -0.36);
    render(<RegressionRunLab step={{ ...step, n: 12, regression_outcome: "production", title: "生产回归：关税与复杂 GVC 生产份额" }} meta={meta} state={{ ...state, data: { run } as never }} />);
    await waitFor(() => expect(document.querySelector(".reg-identity-note")).not.toBeNull());
    const note = document.querySelector(".diverging-bars > .reg-identity-note");
    expect(note?.textContent).toContain("四项份额合计 100%，所以这四条相加约为 0");
    // After the drawing, inside the same card.
    expect(note?.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
  });

  test("step 12 bars: the weak Y is grey with 方向不确定, and one line says the four forward shares add up to about 0", () => {
    const items = [
      estimate("3b_VA_GVC_C_share", "复杂 GVC 生产份额", -0.3756, -0.39, -0.36, { default: true }),
      estimate("3_VA_GVC_share", "前向 GVC 生产总份额", -0.6801, -0.70, -0.66),
      estimate("3a_VA_GVC_S_share", "简单 GVC 生产份额", -0.3045, -0.32, -0.29),
      estimate("2_VA_RT_share", "传统贸易生产份额", -0.2950, -0.31, -0.28),
      estimate("1_VA_D_share", "纯国内生产份额", 0.9752, 0.95, 1.0),
      estimate("3b_FGY_GVC_C_share", "后向复杂 GVC 生产份额", 0.00752, -0.0112, 0.0262),
    ];
    const { rows, unitTitle } = familyBarRows("production", items, "3b_VA_GVC_C_share");
    expect(unitTitle).toBe("X 每高 1 个百分点，Y 两年累计平均相差（个百分点）");
    const weak = rows.find((row) => row.key === "3b_FGY_GVC_C_share")!;
    expect([weak.uncertain, weak.valueLabel, weak.intervalLabel]).toEqual([true, "+0.008", "[-0.011, +0.026] 个百分点"]);
    expect(rows.filter((row) => row.uncertain)).toHaveLength(1);
    expect(forwardShareIdentity(items)).toBe("纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（0.00）；前向 GVC 生产总份额 = 简单 + 复杂（按未取整的原值精确相加，条旁取整后的数字可能相差末位 1）。本步默认的“复杂 GVC 生产份额”按增加值来源（前向）计算；“后向复杂 GVC 生产份额”按最终品（后向）计算，是另一项指标。");
    expect(forwardShareIdentity(items.slice(0, 3))).toBeNull();
  });

  test("a newer step 10 choice that was not recorded yet is said next to the conversion", () => {
    const recorded = { first: "CAN", second: "AUS", industry: "C29" };
    expect(pendingStepTenExample({ browse_selection: { first: "CAN", second: "AUS", industry: "C29" } }, recorded)).toBeNull();
    expect(pendingStepTenExample({ browse_selection: { first: "CAN", second: "", industry: "C29" } }, { first: "CAN", industry: "C29" })).toBeNull();
    expect(pendingStepTenExample({}, recorded)).toBeNull();
    const note = pendingStepTenExample({ browse_selection: { first: "MYS", second: "", industry: "C28" } }, recorded)!;
    expect(note).toContain("步骤 10 最后选的例子（MYS 马来西亚 · C28");
    expect(note).toContain("这里仍按已记录的例子换算");
  });

  test("step 11: one line says the domestic and foreign value-added shares move about opposite", () => {
    const fva = estimate("FVA_share", "外国增加值项占比", 0.20, 0.18, 0.22, { default: true });
    const dva = estimate("DVAex_share", "国内增加值出口占比", -0.19, -0.21, -0.17);
    expect(tradeShareIdentity([fva, dva])).toBe("课程数据里，国内增加值出口占比 = 100% − 外国增加值项占比 − 其余小项（重复计算等），所以这两条大小相近、方向相反。");
    expect(tradeShareIdentity([fva])).toBeNull();
  });

  test("个标准差 uses the within SD (after removing each unit's level and the year effect), not the pooled SD", () => {
    // Pooled 0.58 vs within 0.038 (the release's step 13 default): the size is 0.0184 ÷ 0.038, about 0.48.
    const { rows } = familyBarRows("length", [
      estimate("PLv_GVC", "前向 GVC 段长度", -1.8414, -1.92, -1.76, { kind: "length", default: true, depvar_std: 0.58, depvar_within_std: 0.0383 }),
    ], "PLv_GVC");
    expect(rows[0].valueLabel).toBe("-0.0184（-0.48 个标准差）");
  });

  test("steps 13 and 14 bars are in 个标准差 with the native value and unit; network labels drop their step 5 detail", () => {
    const length = familyBarRows("length", [
      estimate("PLv_GVC", "前向 GVC 段长度", -1.8143, -1.9, -1.7, { kind: "length", default: true, depvar_within_std: 0.4 }),
      estimate("GVCPs", "GVC 位置指数", -0.0768, -0.09, -0.06, { kind: "position", depvar_within_std: 0.05 }),
    ], "PLv_GVC");
    expect(length.unitTitle).toBe("X 每高 1 个百分点，Y 两年累计平均相差（个标准差）");
    expect(length.rows.map((row) => [row.sublabel, row.valueLabel])).toEqual([
      // Each bar in its own headline's digits.
      ["长度单位", "-0.0181（-0.045 个标准差）"],
      ["比值，无单位", "-0.0008（-0.015 个标准差）"],
    ]);
    const network = familyBarRows("network", [
      estimate("weighted_degree", "加权总度（入+出）", -4010.70, -4109.84, -3911.56, { kind: "network", default: true, depvar_within_std: 856 }),
      estimate("betweenesscentrality", "网络介数（全正边二值）", -6011.39, -6400, -5600, { kind: "network", depvar_within_std: 1300, status: "insufficient", suppress_inference: true }),
    ], "weighted_degree");
    expect(network.rows.map((row) => [row.label, row.valueLabel, row.uncertain])).toEqual([
      ["加权总度", "-40.11（-0.047 个标准差）", false],
      ["介数", "-60.11（-0.046 个标准差）", true],
    ]);
    expect([network.rows[1].low, network.rows[1].high]).toEqual([null, null]);
    expect(network.rows[1].note).toBe("这次的数据不够判断方向，不显示 95% 区间");
  });

  test("each bar keeps its headline's digits (end labels, tooltips and what is read aloud)", () => {
    // A shared count per chart printed step 12's -0.3949 as "-0.395" beside the headline's "-0.39"; now every bar reads
    // as its step's headline, even where one chart mixes decimals ("-0.0184", "-0.015", "-0.0006").
    const length = familyBarRows("length", [
      estimate("PLv_GVC", "前向 GVC 段长度", -1.8414, -1.92, -1.76, { kind: "length", default: true, depvar_within_std: 0.58 }),
      estimate("PLy_GVC", "后向 GVC 段长度", -1.5231, -1.62, -1.43, { kind: "length", depvar_within_std: 0.58 }),
      estimate("GVCPs", "GVC 位置指数", -0.0612, -0.08, -0.04, { kind: "position", depvar_within_std: 0.17 }),
    ], "PLv_GVC");
    expect(length.rows.map((row) => row.valueLabel)).toEqual([
      "-0.0184（-0.032 个标准差）", "-0.0152（-0.026 个标准差）", "-0.0006（-0.004 个标准差）",
    ]);
    expect(length.rows[1].spokenLabel).toBe("-0.0152 个长度单位（-0.026 个标准差），95% 区间 [-0.028, -0.025] 个标准差");
    expect(length.rows[1].intervalLabel).toBe("[-0.028, -0.025] 个标准差");
    // Step 12: only the small estimate takes three decimals ("+0.008", never "+0.01").
    const production = familyBarRows("production", [
      estimate("3b_VA_GVC_C_share", "复杂 GVC 生产份额", -0.4012, -0.42, -0.38, { default: true }),
      estimate("1_VA_D_share", "纯国内生产份额", 1.0031, 0.98, 1.03),
      estimate("3b_FGY_GVC_C_share", "后向复杂 GVC 生产份额", 0.0081, -0.002, 0.018),
    ], "3b_VA_GVC_C_share");
    expect(production.rows.map((row) => row.valueLabel)).toEqual(["-0.40", "+1.00", "+0.008"]);
    expect(production.rows[0].intervalLabel).toBe("[-0.42, -0.38] 个百分点");
    // Step 14: the degrees keep two decimals; closeness, too small for them, keeps two significant digits.
    const network = familyBarRows("network", [
      estimate("weighted_degree", "加权总度（入+出）", -4080.37, -4158.54, -4002.2, { kind: "network", default: true, depvar_within_std: 856 }),
      estimate("betweenesscentrality", "网络介数（全正边二值）", -6011.39, -6400, -5600, { kind: "network", depvar_within_std: 1300 }),
      estimate("closnesscentrality", "接近中心性", -0.4884, -0.5045, -0.4722, { kind: "network", depvar_within_std: 0.11 }),
    ], "weighted_degree");
    expect(network.rows.map((row) => row.valueLabel.split("（")[0])).toEqual(["-40.80", "-60.11", "-0.0049"]);
  });

  test("converts the estimate to the example's X in each step's own units", () => {
    expect(exampleEffect("trade", -0.55, 9.32)).toBe("5.13 个百分点");
    expect(exampleEffect("length", -0.018, 9.32)).toBe("0.168 个长度单位");
    expect(exampleEffect("network", -40, 9.32)).toBe("373 个中心性原始单位");
    expect(exampleEffect("network", -20, 9.32)).toBe("186 个中心性原始单位");
    // A closeness change below the shown precision says so instead of printing "-0.00000".
    expect(exampleEffect("network", -0.0049, 0.00039)).toBe("不到 0.00001 个中心性原始单位");
    expect(exampleEffect("network", -0.005, 16.93)).toBe("0.0847 个中心性原始单位");
    expect(exampleEffect("network", -0.6, 10)).toBe("6.00 个中心性原始单位");
    // Closeness gaps (~0.005) need decimals; a fixed 0 printed "低 0" and "估计的差距 −0".
    expect(networkDigits(0.0049)).toBe(5);
    expect(networkDigits(0.012)).toBe(4);
    expect(networkDigits(59)).toBe(1);
    // With a chosen baseline the design says how Y is read.
    expect(exampleEffect("length", -0.004, 9.32, { depvar_kind: "position" })).toBe("0.0373");
    expect(exampleEffect("trade", 0.55, 9.32, { depvar_kind: "share" })).toBe("5.13 个百分点");
  });

  test("the 加税前后 chart states the parallel-trends premise and its two pre-tariff years", () => {
    expect(parallelTrendsNote([2016, 2017, 2018, 2019, 2020], 2018)).toBe(
      "这张图也用来看回归的前提：如果没有关税，扣掉汇率等同期变化后，两组的走势应大致平行。加税前只有 2016、2017 两年可看，能检验的证据有限；被加税名单按对美货物顺差确定，不是随机分配。本课程的 Y 按设定生成，控制汇率、GDP 对数和贸易开放度后，这个前提按设计成立。",
    );
  });

  test("a conversion multiplies the printed estimate by the printed X, so it checks by hand", () => {
    // Headline "-0.55 个百分点" × X "20.44" = "11.24", not the unrounded -0.5517 × 20.44 = 11.28.
    const perPoint = shownPerPoint("trade", { coef: -0.5517, ci_low: -0.61, ci_high: -0.49 });
    expect(perPoint).toBe(-0.55);
    expect(exampleEffect("trade", perPoint, 20.44)).toBe("11.24 个百分点");
    // Half up on the decimal product, as by hand: 0.018 × 23.25 = 0.4185 → 0.419.
    expect(exampleEffect("length", -0.018, 23.25)).toBe("0.419 个长度单位");
    // Lengths print the estimate per point (coef × 0.01) in 3 decimals: -1.5378 → -0.015.
    expect(shownPerPoint("length", { coef: -1.5378, ci_low: -1.9, ci_high: -1.2 })).toBe(-0.0154);
  });

  test("network conversions group thousands, as the report does", () => {
    expect(exampleEffect("network", -40, 34.55)).toBe("1,382 个中心性原始单位");
    expect(groupedFixed(-1382.4, 0)).toBe("-1,382");
    expect(groupedFixed(12.345, 2)).toBe("12.35");
    // Rounds to zero: no negative zero.
    expect(groupedFixed(-0.0004, 2)).toBe("0.00");
  });

  test("the course model's headline is the cumulative relation, split into the tariff's year and the next", () => {
    const run = FVA();
    const twoYear = {
      ...run,
      result: {
        ...run.result,
        coefs: [
          { ...run.result.coefs[0], coef: -0.33, ci_low: -0.35, ci_high: -0.31 },
          { ...run.result.coefs[0], name: "teaching_tariff_exposure_lag1", coef: -0.22, ci_low: -0.24, ci_high: -0.2 },
          { ...run.result.coefs[0], name: "teaching_exchange_rate_change", coef: -0.005, ci_low: -0.006, ci_high: -0.004 },
        ],
        cumulative: { ...run.result.coefs[0], name: "cumulative", coef: -0.55, ci_low: -0.57, ci_high: -0.53 },
      },
    };
    expect(lagSplit("trade", twoYear as never)).toBe("其中当年 -0.33 个百分点，次年再 -0.22 个百分点，两者相加就是两年累计；“平均”指对所有国家×行业取平均。");
    expect(lagSplit("trade", run as never)).toBeNull();
    render(<RegressionResultCard outcome="trade" response={{ ...twoYear, benchmark } as never} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("两年累计平均低 0.55 个百分点");
    expect(document.querySelector(".reg-lag-split")?.textContent).toContain("其中当年 -0.33 个百分点");
    cleanup();
    // The parts take the headline's decimals: a sum read to 3 decimals splits to 3 decimals, not 2.
    const small = {
      ...twoYear,
      result: {
        ...twoYear.result,
        coefs: [
          { ...twoYear.result.coefs[0], coef: 0.0412 },
          { ...twoYear.result.coefs[1], coef: 0.0331 },
          twoYear.result.coefs[2],
        ],
        cumulative: { ...twoYear.result.cumulative, coef: 0.0743, ci_low: 0.061, ci_high: 0.0876 },
      },
    };
    expect(lagSplit("trade", small as never)).toBe("其中当年 +0.041 个百分点，次年再 +0.033 个百分点，两者相加就是两年累计；“平均”指对所有国家×行业取平均。");
    // "两年累计" is said for X + L1.X only: a sum of other terms is not over the tariff's year and the next.
    render(<RegressionResultCard outcome="trade" response={{ ...twoYear, design: { ...twoYear.design, spec: { x_lags: [0, 2], controls: [], fixed_effects: ["year"] } }, benchmark } as never} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).not.toContain("两年累计");
  });

  test("step 14 says weighted degree is in + out once all three are in the family", () => {
    const degree = [
      estimate("weighted_degree", "加权总度（入+出）", -4010.7, -4109.8, -3911.6, { kind: "network", default: true }),
      estimate("weighted_indegree", "加权入度", -1991, -2050, -1930, { kind: "network" }),
      estimate("weighted_outdegree", "加权出度", -2020, -2080, -1960, { kind: "network" }),
    ];
    expect(degreeIdentity(degree)).toBe("加权总度 = 加权入度 + 加权出度，所以这两条的原始值相加约等于加权总度那一条。");
    expect(degreeIdentity(degree.slice(0, 2))).toBeNull();
  });

  test("keeps request states accessible", () => {
    expect(renderToStaticMarkup(<RegressionRequestError label="回归选项" error="Failed to fetch" onRetry={() => {}} />)).toContain('role="alert"');
  });

  test("scrolls only nested course content", () => {
    const calls: ScrollToOptions[] = [];
    const scroller = { scrollTop: 10, getBoundingClientRect: () => ({ top: 20 }), scrollTo: (x: ScrollToOptions) => calls.push(x) };
    const target = { closest: () => scroller, getBoundingClientRect: () => ({ top: 50 }) } as unknown as HTMLElement;
    scrollIntoCourseContent(target, "smooth");
    expect(calls).toEqual([{ top: 40, left: 0, behavior: "smooth" }]);
  });
});

describe("previewing another Y from the bars", () => {

  test("the bars say how to use them from the keyboard, show the tooltip on focus and read the preview aloud", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockResolvedValue({ ...DVA(), benchmark } as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const group = await screen.findByRole("group", { name: /（键盘：方向键切换，Enter 查看）/ });
    expect(group.getAttribute("aria-label")).toContain("本步 2 个 Y · 点击任一条查看该 Y 的读数（键盘：方向键切换，Enter 查看）");
    const tip = () => document.querySelector<HTMLElement>(".diverging-bars > div[style*='pointer-events']");
    const other = screen.getByRole("button", { name: DVA_BAR });
    fireEvent.focus(other);
    expect(tip()?.textContent).toContain("95% 区间");
    expect(tip()?.textContent).toContain("国内增加值出口占比");
    expect(tip()?.style.opacity).toBe("1");
    fireEvent.blur(other);
    expect(tip()?.style.opacity).toBe("0");
    other.focus();
    fireEvent.keyDown(other, { key: "Enter" });
    await waitFor(() => expect(document.querySelector(".reg-bar-preview")?.textContent).toBe(`预览 · ${DVA_BAR}。本步的结论和报告材料仍是外国增加值项占比。`));
    expect(barPreviewText({ key: "k", label: "国内增加值出口占比", value: 0.5561, low: 0.535, high: 0.577, uncertain: false, valueLabel: "+0.56", spokenLabel: "+0.56 个百分点，95% 区间 [+0.54, +0.58]" }, "外国增加值项占比"))
      .toBe(`预览 · ${DVA_BAR}。本步的结论和报告材料仍是外国增加值项占比。`);
    expect(run).not.toHaveBeenCalled();
  });

  test("a run cut off by leaving the step says so once when the step is shown again", async () => {
    mockApis();
    spyOn(api, "runRegression").mockImplementation(() => new Promise(() => {}) as never);
    const first = render(<RegressionRunLab step={step} meta={meta} state={state} />);
    fireEvent.click(await screen.findByRole("button", { name: /^计算贸易流回归/ }));
    await screen.findAllByText("正在计算…");
    first.unmount();
    const back = render(<RegressionRunLab step={step} meta={meta} state={state} />);
    expect(screen.getByText(INTERRUPTED_RUN_NOTE)).toBeTruthy();
    back.unmount();
    render(<RegressionRunLab step={step} meta={meta} state={state} />);
    expect(screen.queryByText(INTERRUPTED_RUN_NOTE)).toBeNull();
  });
});

test("the model's equation reads its lagged X and its controls as symbols, not column names", () => {
  expect(equationSymbol({ text: "teaching_y_trade_ijt", term: "dependent" })).toBe("Y_ijt");
  expect(equationSymbol({ text: "β₁·teaching_tariff_exposure_ijt", term: "policy" })).toBe("β₁·X_ijt");
  expect(equationSymbol({ text: "β₂·teaching_tariff_exposure_lag1_ijt", term: "policy" })).toBe("β₂·L1.X_ijt");
  expect(equationSymbol({ text: "γ₁·teaching_exchange_rate_change_it", term: "control" })).toBe("γ₁·汇率变动_it");
  expect(equationSymbol({ text: "γ₂·log_gdp_proxy__lag1_it", term: "control" })).toBe("γ₂·L1.增加值总额对数_it");
  // The single-X model's wording is unchanged.
  expect(equationSymbol({ text: "β·teaching_tariff_exposure_ijt", term: "policy" })).toBe("β·X_ijt");
});
