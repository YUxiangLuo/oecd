import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import {
  degreeIdentity, exampleEffect, parallelTrendsNote, familyBarRows, forwardShareIdentity, GROUP_CHART_CAPTION, groupedFixed, groupLines, INTERRUPTED_RUN_NOTE, lagSplit, waveMarkers, networkDigits, RegressionRequestError,
  equationSymbol, RegressionResultCard, RegressionRunLab, scrollRegressionVerdict, stepMaterialChanged, TEACHING_MODEL_VERSION,
} from "./regression";
import type {
  RegressionOutcome, Step, StepStateApi, TeachingEstimate, TeachingGroupsResponse, TeachingOverviewResponse, TeachingPanelResponse,
} from "./types";
import { GENERATED_DATA_NOTE, GENERATED_Y_DISCLOSURE } from "./regression-lessons";
import { shownPerPoint } from "./regression-verdict";

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
// Teaching data v10: two waves (2018, 2019) and the untaxed; `taxed` pools the waves.
const waves = (taxed: number, untaxed: number) => ({
  taxed: series(taxed), first: series(taxed), second: series(taxed / 2, 3), untaxed: series(untaxed),
});
const groups: TeachingGroupsResponse = {
  version: "v", years: [2016, 2017, 2018, 2019, 2020], policy_year: 2018, policy_years: [2018, 2019], mean_exposure_taxed: 0.03,
  sample: {
    rows: 16000, entities: 3200, countries: 75, industries: 44, taxed_countries: 37, untaxed_countries: 38,
    first_wave_countries: 14, second_wave_countries: 23,
  },
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
/** A submitted report built from FVA; the page saves into its own state, as the session does. */
function LockedLab({ initial, outdated = true }: { initial: ReturnType<typeof FVA>; outdated?: boolean }) {
  const [data, setData] = useState<Record<string, unknown>>({ run: initial });
  return (
    <RegressionRunLab
      step={step}
      meta={meta}
      state={{ ...state, materialLocked: true, data: data as never, save: (patch) => setData((current) => ({ ...current, ...patch })) }}
      reportRuns={[{ step: 11, outcome: "trade", design: FVA().design, result: FVA().result }] as never}
      reportOutdated={outdated}
    />
  );
}
const benchmark = { backend: "x", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "x", notes: [] };
const mockApis = () => {
  spyOn(api, "teachingGroups").mockResolvedValue(groups);
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

  test("one run saves the default Y and draws one bar per Y; clicking another bar runs and saves that Y", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockImplementation(async (_outcome, _signal, baseline) =>
      ({ ...(baseline === "DVAex_share" ? DVA() : FVA()), benchmark }) as never);
    const saves: Record<string, unknown>[] = [];
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, save: (patch) => { saves.push(patch); } }} />);
    fireEvent.click(await screen.findByRole("button", { name: /^计算贸易流回归/ }));
    await waitFor(() => expect(document.querySelectorAll("[data-bar]")).toHaveLength(2));
    expect(run.mock.calls[0][2]).toBeNull();
    expect((saves[0].run as { design: { baseline: string } }).design.baseline).toBe("FVA_share");
    const pressed = screen.getAllByRole("button", { pressed: true });
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute("aria-label")).toBe(`${FVA_BAR}，已保存`);
    // The saved bar's label is the headline's number.
    expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("外国增加值项占比平均低 0.55 个百分点");
    // The result card opens with the generated-data disclosure, before the headline.
    const card = document.querySelector(".verdict-card")!;
    expect(card.firstElementChild?.textContent).toBe(GENERATED_Y_DISCLOSURE);
    expect(card.textContent?.split(GENERATED_DATA_NOTE)).toHaveLength(1);
    expect(screen.getByRole("group", { name: /X 每高 1 个百分点，Y 平均相差（个百分点）/ })).toBeTruthy();
    // Model and numbers are folded away.
    // (The 加税前后 chart's per-year table is folded under the chart.)
    expect([...document.querySelectorAll("details > summary")].map((node) => node.textContent)).toEqual(["各组逐年读数", "模型设定", "详细数字（可选）"]);
    fireEvent.click(screen.getByRole("button", { name: DVA_BAR }));
    await waitFor(() => expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("国内增加值出口占比平均高 0.56 个百分点"));
    expect(run.mock.calls[1][2]).toBe("DVAex_share");
    expect((saves[1].run as { design: { baseline: string } }).design.baseline).toBe("DVAex_share");
    expect(screen.getByRole("button", { pressed: true }).getAttribute("aria-label")).toBe(`${DVA_BAR}，已保存`);
    // The trend chart and the question follow the saved Y.
    expect(screen.getByRole("img", { name: /加税前后：各组国内增加值出口占比的平均变化/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /国内增加值出口占比（Y）/ })).toBeTruthy();
    // Clicking the saved bar again does not run.
    fireEvent.click(screen.getByRole("button", { pressed: true }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("a click on a grey (方向不确定) bar asks before saving it; 取消 keeps the saved Y", async () => {
    mockApis();
    // DVA's interval includes 0 here: its bar is grey.
    spyOn(api, "teachingOverview").mockResolvedValue({ ...overview, outcomes: { ...overview.outcomes, trade: [
      overview.outcomes.trade[0], estimate("DVAex_share", "国内增加值出口占比", 0.05, -0.1, 0.2),
    ] } });
    const run = spyOn(api, "runRegression").mockImplementation(async () => ({ ...savedRun("DVAex_share", "国内增加值出口占比", 0.05, -0.1, 0.2), benchmark }) as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const grey = await screen.findByRole("button", { name: /^国内增加值出口占比：/ });
    fireEvent.click(grey);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("改为保存方向不确定的这一项？");
    expect(dialog.textContent).toContain("“国内增加值出口占比”的 95% 区间包含 0");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(grey);
    fireEvent.click(await screen.findByRole("button", { name: "改为保存" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][2]).toBe("DVAex_share");
  });

  test("while a run is in flight the bars cannot be selected", async () => {
    mockApis();
    let finish: (value: unknown) => void = () => {};
    const run = spyOn(api, "runRegression").mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const other = await screen.findByRole("button", { name: DVA_BAR });
    fireEvent.click(other);
    await waitFor(() => expect(other.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: `${FVA_BAR}，已保存` }));
    fireEvent.keyDown(other, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    finish({ ...DVA(), benchmark });
    await waitFor(() => expect(document.querySelector('[data-bar="DVAex_share"]')?.getAttribute("aria-disabled")).toBeNull());
  });

  test("restores the saved run's Y on refresh, and never starts from the matching step 6-9 indicator", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: savedRun("DVAex_share", "国内增加值出口占比") } as never }} />);
    await waitFor(() => expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("国内增加值出口占比平均高 0.50 个百分点"));
    // The saved run, not the overview, is the selected bar: page and report agree.
    await screen.findByRole("button", { name: "国内增加值出口占比：+0.50 个百分点，95% 区间 [+0.40, +0.60]，已保存" });
    expect(document.body.textContent).not.toContain("教学模拟");
    cleanup();
    const getStep = ((n: number) => n === 6 ? { indicator_selection: { metric: "DVAex_share" } } : undefined) as <T>(step: number) => T | undefined;
    const run = spyOn(api, "runRegression").mockResolvedValue({ ...FVA(), benchmark } as never);
    render(<RegressionRunLab step={step} meta={meta} state={state} getStep={getStep} />);
    expect(screen.getByRole("heading", { name: /外国增加值项占比（Y）/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^计算贸易流回归/ }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0][2]).toBeNull();
  });

  test("the detailed-numbers notes match the table: no <0.0001 note without such a p, and rounding is named", async () => {
    mockApis();
    const run = savedRun("DVAex_share", "国内增加值出口占比");
    const { unmount } = render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run } as never }} />);
    await waitFor(() => expect(document.querySelectorAll(".technical-details")).toHaveLength(2));
    const details = () => document.querySelectorAll(".technical-details")[1]!.textContent ?? "";
    expect(details()).not.toContain("很小的 p 值");
    expect(details()).toContain("两列是同一个数，左列按页面精度四舍五入");
    // The model settings hold the formula and the design, folded.
    expect(document.querySelectorAll(".technical-details")[0]!.textContent).toContain("双向固定效应");
    unmount();
    const tiny = { ...run, result: { ...run.result, coefs: [{ ...run.result.coefs[0], p: 0.00001 }] } };
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: tiny } as never }} />);
    await waitFor(() => expect(document.querySelectorAll(".technical-details")).toHaveLength(2));
    expect(details()).toContain("很小的 p 值显示为 <0.0001");
  });

  test("a saved result makes recalculating secondary, and a failed recalculation labels the old result", async () => {
    mockApis();
    spyOn(api, "runRegression").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, materialLocked: true, data: { run: FVA() } as never }} />);
    const rerun = await screen.findByRole("button", { name: "重新计算贸易流回归" });
    expect(rerun.className).toBe("run-btn secondary");
    // A submitted report: the warning is a callout, not a grey footnote.
    expect(document.querySelector(".reg-rerun-warning")?.textContent).toContain("重新计算或点击另一条，会替换报告材料里保存的结果");
    fireEvent.click(rerun);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("贸易流回归未完成：网络连接中断，请检查连接后重试。");
    // The run button is the one retry action; the old result stays, said to be the last saved one.
    expect(screen.getByRole("button", { name: "重试：计算贸易流回归" }).className).toBe("run-btn");
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("这次计算没有成功；下面仍是上次保存的结果。");
    expect(document.querySelector(".reg-results-stale .reg-plain-verdict")).not.toBeNull();
  });

  test("a failed bar click is retried with the clicked Y, named on the button", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    fireEvent.click(await screen.findByRole("button", { name: /^国内增加值出口占比：/ }));
    const retry = await screen.findByRole("button", { name: "重试：保存“国内增加值出口占比”" });
    run.mockResolvedValue({ ...DVA(), benchmark } as never);
    fireEvent.click(retry);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][2]).toBe("DVAex_share");
    await waitFor(() => expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("国内增加值出口占比平均高"));
    expect(screen.getByRole("button", { name: "重新计算贸易流回归" })).toBeTruthy();
  });

  test("a failed bar click shows its error and retry under the bars, brought into view, worded as saving", async () => {
    // Offline at 1440×900 with the bars at the top: the error and the retry (up in the run card) were out of view.
    mockApis();
    spyOn(api, "runRegression").mockRejectedValue(new TypeError("Failed to fetch"));
    const scrolled: Element[] = [];
    const scrollIntoView = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) { scrolled.push(this); });
    try {
      render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
      fireEvent.click(await screen.findByRole("button", { name: /^国内增加值出口占比：/ }));
      const alert = await screen.findByRole("alert");
      expect(alert.closest(".reg-family-bars")).not.toBeNull();
      expect(alert.textContent).toContain("保存“国内增加值出口占比”没有成功：网络连接中断，请检查连接后重试。");
      expect(alert.textContent).toContain("图和下面仍是上次保存的结果（外国增加值项占比）。");
      expect(alert.textContent).not.toContain("计算");
      // One retry, next to the error; the run button above recalculates the saved Y as usual.
      expect(alert.querySelector("button")?.textContent).toBe("重试：保存“国内增加值出口占比”");
      expect(screen.getByRole("button", { name: "重新计算贸易流回归" }).className).toBe("run-btn secondary");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(document.querySelector(".reg-stale-note")).toBeNull();
      await waitFor(() => expect(scrolled).toContain(alert));
      expect(scrollIntoView.mock.calls.at(-1)?.[0]).toMatchObject({ block: "nearest" });
    } finally {
      scrollIntoView.mockRestore();
    }
    // At full strength while the bars fade, with room above it when scrolled into view.
    const css = await Bun.file(new URL("./workbench.css", import.meta.url)).text();
    expect(css).toContain(".reg-results-stale .reg-family-bars > :not(.reg-bar-error) { opacity: .62; }");
    expect(css).toMatch(/\.reg-bar-error \{[^}]*scroll-margin: 16px 0 16px;/);
  });

  test("after a submitted report, clicking another bar says the material has already been replaced", async () => {
    mockApis();
    spyOn(api, "runRegression").mockResolvedValue({ ...DVA(), benchmark } as never);
    render(<LockedLab initial={FVA()} />);
    expect((await screen.findByRole("button", { name: "重新计算贸易流回归" })).className).toBe("run-btn secondary");
    const scrolled: ScrollIntoViewOptions[] = [];
    const scrollIntoView = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation((options) => { scrolled.push(options as ScrollIntoViewOptions); });
    try {
      const bar = await screen.findByRole("button", { name: DVA_BAR });
      bar.focus();
      fireEvent.click(bar);
      // The notice sits under the bars, in the chart card, where the click happened (not up in the run card).
      await waitFor(() => expect(document.querySelector(".diverging-bars .reg-replaced-notice")?.textContent)
        .toBe("已改为保存这个 Y 的结果；报告已提交，请到步骤 15 更新报告并重新提交给老师。"));
      expect(document.querySelectorAll(".reg-rerun-warning")).toHaveLength(1);
      expect(document.querySelector(".reg-run-card .reg-rerun-warning")).toBeNull();
      expect(document.body.textContent).not.toContain("这次算出的");
      expect(document.querySelector(".reg-replaced-notice")?.getAttribute("role")).toBe("status");
      // Brought into view without taking keyboard focus from the bars.
      await waitFor(() => expect(scrolled).toEqual([{ block: "nearest", behavior: "smooth" }]));
      expect(document.activeElement?.getAttribute("data-bar")).toBe("DVAex_share");
    } finally { scrollIntoView.mockRestore(); }
  });

  test("after a submitted report, going back to the Y the report used withdraws the update notice", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockResolvedValue({ ...DVA(), benchmark } as never);
    render(<LockedLab initial={FVA()} />);
    fireEvent.click(await screen.findByRole("button", { name: DVA_BAR }));
    await waitFor(() => expect(document.querySelector(".reg-replaced-notice")).not.toBeNull());
    // Clicking the bar of the Y the report was built from (here FVA) restores that material: no update is needed.
    run.mockResolvedValue({ ...FVA(), benchmark } as never);
    fireEvent.click(await screen.findByRole("button", { name: /^外国增加值项占比：/ }));
    await waitFor(() => expect(document.querySelector(".reg-replaced-notice")).toBeNull(), { timeout: 4000 });
    expect(document.querySelector(".reg-rerun-warning")?.textContent).toContain("重新计算或点击另一条，会替换报告材料里保存的结果");
  }, 15000);

  test("after a reload the notice follows the report: a stale step says so, the submitted Y does not", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockResolvedValue({ ...FVA(), benchmark } as never);
    // (a) The page opens on DVA while the report was built from FVA and the report is out of date.
    render(<LockedLab initial={DVA()} />);
    await waitFor(() => expect(document.querySelector(".reg-replaced-notice")?.textContent)
      .toBe("本步保存的结果与已提交报告里的不同；请到步骤 15 更新报告并重新提交给老师。"));
    // (b) Back to the Y the report used: withdrawn, although it is not the Y the page opened on.
    fireEvent.click(await screen.findByRole("button", { name: /^外国增加值项占比：/ }));
    await waitFor(() => expect(document.querySelector(".reg-replaced-notice")).toBeNull(), { timeout: 4000 });
    expect(run).toHaveBeenCalledTimes(1);
    cleanup();
    // A current report (the sidebar's 15/15) never shows it, whatever this page saved.
    render(<LockedLab initial={DVA()} outdated={false} />);
    await screen.findByRole("button", { name: /^国内增加值出口占比：/ });
    expect(document.querySelector(".reg-replaced-notice")).toBeNull();
  }, 15000);

  test("which step changed: only the step whose saved runs differ from the report's", () => {
    const reported = [{ step: 11, outcome: "trade", design: FVA().design, result: FVA().result }] as never;
    expect(stepMaterialChanged(11, { run: FVA() } as never, reported)).toBe(false);
    expect(stepMaterialChanged(11, { run: FVA(), qualified_run: FVA() } as never, reported)).toBe(false);
    expect(stepMaterialChanged(11, { run: DVA() } as never, reported)).toBe(true);
    // A changed qualified run changes what the report prints for the step, too.
    expect(stepMaterialChanged(11, { run: FVA(), qualified_run: DVA() } as never, reported)).toBe(true);
    expect(stepMaterialChanged(12, { run: FVA() } as never, reported)).toBe(true);
  });

  test("the 加税前后 chart draws the two waves and the untaxed, marks both tariff years and has no estimate bracket", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    await screen.findByRole("img", { name: /加税前后/ });
    expect([...document.querySelectorAll("[data-line]")].map((node) => node.getAttribute("data-line"))).toEqual(["first", "second", "untaxed"]);
    expect([...document.querySelectorAll("[data-marker] text")].map((node) => node.textContent)).toEqual(["2018 年第一批加税", "2019 年第二批加税"]);
    // The raw gaps mix the tariff with what else changed: no bracket claims the regression's gap on the chart.
    expect(document.querySelector("[data-estimate-label]")).toBeNull();
    expect(document.querySelector(".reg-group-figure .reg-gap-caption")?.textContent).toBe(GROUP_CHART_CAPTION);
    expect(GROUP_CHART_CAPTION).not.toMatch(/高估|低估|汇率.*(高|低)/);
  });

  test("before the run the chart and its caption are there too, with the premise for every group", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={state} />);
    await screen.findByRole("img", { name: /加税前后/ });
    expect(document.querySelector(".reg-gap-caption")?.textContent).toBe(GROUP_CHART_CAPTION);
    expect(document.querySelector(".reg-parallel-note")?.textContent).toContain("如果没有关税，各组的走势应大致平行");
  });

  test("a server before v10 still gets its two lines and one marker", () => {
    const lines = groupLines({ taxed: series(-1), untaxed: series(1) });
    expect(lines.map((line) => line.label)).toEqual(["被加税国家组", "未被加税国家组"]);
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
    expect(tip()).toContain("状态 · 已保存（报告用这个 Y）");
    expect(tip()).not.toContain("点击");
    fireEvent.mouseEnter(screen.getByRole("button", { name: DVA_BAR }), { clientX: 10, clientY: 10 });
    expect(tip()).toContain("操作 · 点击即改为保存此 Y");
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

  test("the detailed numbers table wraps its headers and narrows its cells so step 14's numbers fit", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    await waitFor(() => expect(document.querySelector("table.reg-coef-table")).not.toBeNull());
    const css = await Bun.file(new URL("./workbench.css", import.meta.url)).text();
    expect(css).toMatch(/\.data-table\.reg-coef-table th \{[^}]*white-space: normal;[^}]*padding: 8px 8px;/);
    expect(css).toMatch(/\.data-table\.reg-coef-table td \{[^}]*padding-left: 8px; padding-right: 8px;/);
  });

  test("falls back to the default Y when the saved baseline is not offered by the release", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: savedRun("FDC_share", "外国重复计算项占比") } as never }} />);
    await screen.findByText(/上次计算的 Y（外国重复计算项占比）不在当前课程数据中/);
    // The saved run for the missing Y is not shown as if it were the default's result.
    expect(document.querySelector(".reg-plain-verdict")).toBeNull();
    expect(screen.getByRole("heading", { name: /外国增加值项占比（Y）/ })).toBeTruthy();
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
    expect(unitTitle).toBe("X 每高 1 个百分点，Y 平均相差（个百分点）");
    const weak = rows.find((row) => row.key === "3b_FGY_GVC_C_share")!;
    expect([weak.uncertain, weak.valueLabel, weak.intervalLabel]).toEqual([true, "+0.008", "[-0.011, +0.026] 个百分点"]);
    expect(rows.filter((row) => row.uncertain)).toHaveLength(1);
    expect(forwardShareIdentity(items)).toBe("纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（0.00）；前向 GVC 生产总份额 = 简单 + 复杂（按未取整的原值精确相加，条旁取整后的数字可能相差末位 1）。");
    expect(forwardShareIdentity(items.slice(0, 3))).toBeNull();
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
    expect(length.unitTitle).toBe("X 每高 1 个百分点，Y 平均相差（个标准差）");
    expect(length.rows.map((row) => [row.sublabel, row.valueLabel])).toEqual([
      // Each bar in its own headline's digits.
      ["长度单位", "-0.0181（-0.045 个标准差）"],
      ["无量纲", "-0.0008（-0.015 个标准差）"],
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
      "这张图也用来看回归的前提：如果没有关税，两组的走势应大致平行。加税前只有 2016、2017 两年可看，能检验的证据有限；被加税名单按对美货物顺差确定，不是随机分配。本课程的 Y 按设定生成，这一前提由设计保证。",
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
    expect(lagSplit("trade", twoYear as never)).toBe("其中当年 -0.33 个百分点，次年再 -0.22 个百分点（模型同时放入当年的 X 和上一年的 X，两项之和是累计关联）。");
    expect(lagSplit("trade", run as never)).toBeNull();
    render(<RegressionResultCard outcome="trade" response={{ ...twoYear, benchmark } as never} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain("两年累计平均低 0.55 个百分点");
    expect(document.querySelector(".reg-lag-split")?.textContent).toContain("其中当年 -0.33 个百分点");
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
    scrollRegressionVerdict(target, "smooth");
    expect(calls).toEqual([{ top: 40, left: 0, behavior: "smooth" }]);
  });
});

describe("saving another Y from the bars", () => {
  test("a saved Y that is not the default shows a chip whose button saves the default again", async () => {
    mockApis();
    const run = spyOn(api, "runRegression").mockResolvedValue({ ...FVA(), benchmark } as never);
    const saves: Record<string, unknown>[] = [];
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, save: (patch) => { saves.push(patch); }, data: { run: DVA() } as never }} />);
    await screen.findByRole("button", { name: `${DVA_BAR}，已保存` });
    const chip = document.querySelector(".diverging-bars .reg-saved-chip");
    expect(chip?.textContent).toBe("当前保存：国内增加值出口占比（不是本步默认） · 恢复默认（外国增加值项占比）");
    const reset = screen.getByRole("button", { name: "恢复默认（外国增加值项占比）" });
    reset.focus();
    await act(async () => { fireEvent.click(reset); });
    expect(document.querySelector(".reg-saved-chip")).toBeNull();
    // Through the run flow: the default Y is run and saved.
    expect(run.mock.calls[0][2]).toBeNull();
    expect((saves[0].run as { design: { baseline: string } }).design.baseline).toBe("FVA_share");
    // The chip's button is gone: keyboard focus lands on the bar that is saved now.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.activeElement?.getAttribute("data-bar")).toBe("FVA_share");
  });

  test("the default saved Y shows no chip", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    await screen.findByRole("button", { name: `${FVA_BAR}，已保存` });
    expect(document.querySelector(".reg-saved-chip")).toBeNull();
  });

  test("the bars say how to use them from the keyboard, show the tooltip on focus and announce a save", async () => {
    mockApis();
    spyOn(api, "runRegression").mockResolvedValue({ ...DVA(), benchmark } as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const group = await screen.findByRole("group", { name: /（键盘：方向键切换，Enter 保存）/ });
    expect(group.getAttribute("aria-label")).toContain("本类 2 个 Y · 点击任一条即改为保存该 Y（键盘：方向键切换，Enter 保存）");
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
    await waitFor(() => expect([...document.querySelectorAll("[role='status'][aria-live='polite']")].map((node) => node.textContent))
      .toContain("已保存：国内增加值出口占比"));
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
  expect(equationSymbol({ text: "γ₁·teaching_exchange_rate_change_it", term: "control" })).toBe("γ₁·汇率_it");
  expect(equationSymbol({ text: "γ₂·log_gdp_proxy__lag1_it", term: "control" })).toBe("γ₂·L1.GDP_it");
  // The single-X model's wording is unchanged.
  expect(equationSymbol({ text: "β·teaching_tariff_exposure_ijt", term: "policy" })).toBe("β·X_ijt");
});
