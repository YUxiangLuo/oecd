import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "./api";
import {
  exampleEffect, familyBarRows, forwardShareIdentity, networkDigits, RegressionRequestError,
  RegressionRunLab, scrollRegressionVerdict, TEACHING_MODEL_VERSION,
} from "./regression";
import type {
  RegressionOutcome, Step, StepStateApi, TeachingEstimate, TeachingGroupsResponse, TeachingOverviewResponse, TeachingPanelResponse,
} from "./types";
import { GENERATED_DATA_NOTE } from "./regression-lessons";

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
const series = (taxed: number) => [2016, 2017, 2018, 2019, 2020].map((year, index) => ({ year, change: index < 2 ? 0 : taxed }));
const groups: TeachingGroupsResponse = {
  version: "v", years: [2016, 2017, 2018, 2019, 2020], policy_year: 2018, mean_exposure_taxed: 0.03,
  sample: { rows: 16220, entities: 3244, countries: 76, industries: 44, taxed_countries: 44, untaxed_countries: 32 },
  outcomes: {
    trade: { taxed: series(-0.004), untaxed: series(0.003) },
    production: { taxed: series(-0.003), untaxed: series(0.002) },
    length: { taxed: series(-0.01), untaxed: series(0.01) },
    network: { taxed: series(-40), untaxed: series(30) },
  },
  baselines: {
    trade: [
      { key: "FVA_share", label: "外国增加值项占比", kind: "share", unit: "比例（展示为百分点）", default: true, column: "teaching_y_trade", source: "FVA_share" },
      { key: "DVAex_share", label: "国内增加值出口占比", kind: "share", unit: "比例（展示为百分点）", default: false, column: "teaching_y_trade_DVAex_share", source: "DVAex_share" },
    ],
    production: [], length: [], network: [],
  },
  series: {
    trade: { FVA_share: { taxed: series(-0.004), untaxed: series(0.003) }, DVAex_share: { taxed: series(0.004), untaxed: series(-0.003) } },
    production: {}, length: {}, network: {},
  },
};
const estimate = (key: string, label: string, coef: number, low: number, high: number, extra: Partial<TeachingEstimate> = {}): TeachingEstimate => ({
  key, label, kind: "share", default: false, coef, ci_low: low, ci_high: high, p: 0.001, status: "ok",
  suppress_inference: false, depvar_std: 0.1, depvar_mean: 0.3, n_obs: 16000, ...extra,
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
    depvar_mean: 0.3, depvar_std: 0.1, diagnostics: { study_contract: "economics-v2" }, notes: [], status: "ok", status_reasons: [],
    coefs: [{ name: "teaching_tariff_exposure", coef, se: 0.05, t: 10, p: 0.001, stars: "***", ci_low: low, ci_high: high }],
    support: { treated_clusters: 10, untreated_clusters: 0, treated_entities: 20, untreated_entities: 0, total_entities: 20, reversal_entities: [], reversal_share: 0, absorbing: true, status: "ok", reasons: [], min_treated_clusters: 5, max_reversal_share: 0, suppress_inference: false },
  },
  disclaimer: "教学模拟",
  model_snapshot: { version: TEACHING_MODEL_VERSION, x_columns: ["teaching_tariff_exposure"], y_column: `teaching_y_trade_${baseline}`, baseline, entity: "entity_id", time: "year", fixed_effects: ["entity_id", "year"], controls: [], interactions: [], seed: 1, beta: 0.55, tariff_path: [], disclaimer: "教学" },
  variable_catalog: [],
});
const FVA = () => savedRun("FVA_share", "外国增加值项占比", -0.5493, -0.5711, -0.5274);
const DVA = () => savedRun("DVAex_share", "国内增加值出口占比", 0.5561, 0.535, 0.577);
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
    const figure = await screen.findByRole("img", { name: /加税前后：两组外国增加值项占比的平均变化/ });
    expect(figure.getAttribute("aria-label")).toContain("2018 年起加税");
    expect(figure.textContent).toContain("加税国家组");
    await waitFor(() => expect(screen.getByRole("button", { name: "计算贸易流回归（用全部 16,220 条记录）" })).toBeTruthy());
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
    expect(pressed[0].getAttribute("aria-label")).toBe("外国增加值项占比：-0.55，已保存");
    // The saved bar's label is the headline's number.
    expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("外国增加值项占比平均低 0.55 个百分点");
    expect(screen.getByRole("group", { name: /X 每高 1 个百分点，Y 平均相差（个百分点）/ })).toBeTruthy();
    // Model and numbers are folded away.
    expect([...document.querySelectorAll("details > summary")].map((node) => node.textContent)).toEqual(["模型设定", "详细数字（可选）"]);
    fireEvent.click(screen.getByRole("button", { name: "国内增加值出口占比：+0.56" }));
    await waitFor(() => expect(document.querySelector(".reg-plain-verdict")?.textContent).toContain("国内增加值出口占比平均高 0.56 个百分点"));
    expect(run.mock.calls[1][2]).toBe("DVAex_share");
    expect((saves[1].run as { design: { baseline: string } }).design.baseline).toBe("DVAex_share");
    expect(screen.getByRole("button", { pressed: true }).getAttribute("aria-label")).toBe("国内增加值出口占比：+0.56，已保存");
    // The trend chart and the question follow the saved Y.
    expect(screen.getByRole("img", { name: /加税前后：两组国内增加值出口占比的平均变化/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /国内增加值出口占比（Y）/ })).toBeTruthy();
    // Clicking the saved bar again does not run.
    fireEvent.click(screen.getByRole("button", { pressed: true }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("while a run is in flight the bars cannot be selected", async () => {
    mockApis();
    let finish: (value: unknown) => void = () => {};
    const run = spyOn(api, "runRegression").mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: FVA() } as never }} />);
    const other = await screen.findByRole("button", { name: "国内增加值出口占比：+0.56" });
    fireEvent.click(other);
    await waitFor(() => expect(other.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "外国增加值项占比：-0.55，已保存" }));
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
    await screen.findByRole("button", { name: "国内增加值出口占比：+0.50，已保存" });
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
    expect(document.querySelector(".reg-rerun-warning")?.textContent).toContain("重新计算或点另一条，会替换报告材料里保存的结果");
    fireEvent.click(rerun);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("贸易流回归没有算完：网络连接中断，请检查连接后重试。");
    // The run button is the one retry action; the old result stays, said to be the last saved one.
    expect(screen.getByRole("button", { name: "重试：计算贸易流回归" }).className).toBe("run-btn");
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("这次计算没有成功；下面仍是上次保存的结果。");
    expect(document.querySelector(".reg-results-stale .reg-plain-verdict")).not.toBeNull();
  });

  test("after a submitted report, clicking another bar says the material has already been replaced", async () => {
    mockApis();
    spyOn(api, "runRegression").mockResolvedValue({ ...DVA(), benchmark } as never);
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, materialLocked: true, data: { run: FVA() } as never }} />);
    expect((await screen.findByRole("button", { name: "重新计算贸易流回归" })).className).toBe("run-btn secondary");
    fireEvent.click(await screen.findByRole("button", { name: "国内增加值出口占比：+0.56" }));
    await waitFor(() => expect(document.querySelector(".reg-rerun-warning")?.textContent).toContain("报告材料里保存的结果已换成这次算出的结果；请到步骤 15 更新报告"));
    expect(document.querySelector(".reg-rerun-warning")?.textContent).not.toContain("会替换");
  });

  test("falls back to the default Y when the saved baseline is not offered by the release", async () => {
    mockApis();
    render(<RegressionRunLab step={step} meta={meta} state={{ ...state, data: { run: savedRun("FDC_share", "外国重复计算项占比") } as never }} />);
    await screen.findByText(/上次算的 Y（外国重复计算项占比）在当前课程数据里没有/);
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
    expect(forwardShareIdentity(items)).toBe("纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（0.00）。");
    expect(forwardShareIdentity(items.slice(0, 3))).toBeNull();
  });

  test("steps 13 and 14 bars are in 个标准差 with the native value and unit; network labels drop their step 5 detail", () => {
    const length = familyBarRows("length", [
      estimate("PLv_GVC", "前向 GVC 段长度", -1.8143, -1.9, -1.7, { kind: "length", default: true, depvar_std: 0.4 }),
      estimate("GVCPs", "GVC 位置指数", -0.0768, -0.09, -0.06, { kind: "position", depvar_std: 0.05 }),
    ], "PLv_GVC");
    expect(length.unitTitle).toBe("X 每高 1 个百分点，Y 平均相差（个标准差）");
    expect(length.rows.map((row) => [row.sublabel, row.valueLabel])).toEqual([
      ["长度单位", "-0.018（0.045 个标准差）"],
      ["位置指数单位", "-0.0008（0.015 个标准差）"],
    ]);
    const network = familyBarRows("network", [
      estimate("weighted_degree", "加权总度（入+出）", -4010.70, -4109.84, -3911.56, { kind: "network", default: true, depvar_std: 856 }),
      estimate("betweenesscentrality", "网络介数（全正边二值）", -6011.39, -6400, -5600, { kind: "network", depvar_std: 1300, status: "insufficient", suppress_inference: true }),
    ], "weighted_degree");
    expect(network.rows.map((row) => [row.label, row.valueLabel, row.uncertain])).toEqual([
      ["加权总度", "-40.11（0.047 个标准差）", false],
      ["介数", "-60.11（0.046 个标准差）", true],
    ]);
    expect([network.rows[1].low, network.rows[1].high]).toEqual([null, null]);
    expect(network.rows[1].note).toBe("这次的数据不够判断方向，不显示 95% 区间");
  });

  test("converts the estimate to the example's X in each step's own units", () => {
    expect(exampleEffect("trade", -0.55, 0.0932)).toBe("5.13 个百分点");
    expect(exampleEffect("length", -1.8, 0.0932)).toBe("0.168 个长度单位");
    expect(exampleEffect("network", -4000, 0.0932)).toBe("373 个中心性原始单位");
    expect(exampleEffect("network", -2000, 0.0932)).toBe("186 个中心性原始单位");
    // A closeness change below the shown precision says so instead of printing "-0.00000".
    expect(exampleEffect("network", -0.49, 0.0000039)).toBe("不到 0.00001 个中心性原始单位");
    expect(exampleEffect("network", -0.5, 0.1693)).toBe("0.0847 个中心性原始单位");
    expect(exampleEffect("network", -60, 0.1)).toBe("6.00 个中心性原始单位");
    // Closeness gaps (~0.005) need decimals; a fixed 0 printed "低 0" and "估计的差距 −0".
    expect(networkDigits(0.0049)).toBe(5);
    expect(networkDigits(0.012)).toBe(4);
    expect(networkDigits(59)).toBe(1);
    // With a chosen baseline the design says how Y is read.
    expect(exampleEffect("length", -0.4, 0.0932, { depvar_kind: "position" })).toBe("0.0373 个位置指数单位");
    expect(exampleEffect("trade", 0.55, 0.0932, { depvar_kind: "share" })).toBe("5.13 个百分点");
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
