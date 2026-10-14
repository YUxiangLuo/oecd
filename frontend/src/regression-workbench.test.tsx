import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { api, ApiError } from "./api";
import { ColumnDetails, experimentReportChanged, ModelComparisonChart, RegressionModelWorkbench, type WorkbenchStepState } from "./regression-workbench";
import {
  canonicalSpec, coefficientRows, comparisonCsv, designDeviation, designValueRow, effectiveEffects, equationPreview, experimentLabel, includedBy, omittedSummary, perPointReading,
  perPointRow, samplesDiffer, significanceStars, snapshotOf, specSummary, summaryRows, termLabel,
  type TableColumn,
} from "./regression-workbench-table";
import optionsFixture from "./regression-workbench-options.fixture.json";
import type { CoefStat, Experiment, ModelSpec, RegressionResponse, StepStateApi, WorkbenchOptions } from "./types";

afterEach(() => { cleanup(); mock.restore(); });

const options = optionsFixture as WorkbenchOptions;
const ER = "teaching_exchange_rate_change";
const DEFAULT: ModelSpec = options.default_spec;
const NO_RATE: ModelSpec = { ...DEFAULT, controls: DEFAULT.controls.filter((item) => item.name !== ER) };

const coef = (name: string, value: number, p = 0.001): CoefStat => ({
  name, coef: value, se: Math.abs(value) / 10 || 0.01, t: 10, p, stars: significanceStars(p), ci_low: value - 0.1, ci_high: value + 0.1,
});

function response(spec: ModelSpec, values: Record<string, number>, extra: Partial<RegressionResponse["result"]> = {}, baseline = "FVA_share"): RegressionResponse {
  const coefs = Object.entries(values).map(([name, value]) => coef(name, value));
  const xSum = coefs.filter((item) => item.name.startsWith("teaching_tariff_exposure")).reduce((sum, item) => sum + item.coef, 0);
  return {
    design: {
      outcome: "trade", baseline, depvar: "teaching_y_trade", depvar_label: "外国增加值项占比", depvar_kind: "share",
      granularity: "country_industry", shock_type: "tariff", shock_col: "teaching_tariff_exposure", treated_col: "teaching_treated",
      method: "twfe_intensity", control_mode: "spec", interaction: false, price_mode: "nominal", scenario: "clean", scenario_label: "",
      sample_filter: "", exclude_row: true, controls: [], control_labels: {}, equation: "", equation_parts: [], panel_file: "",
      entity: "entity_id", cluster: "country", spec,
    },
    result: {
      depvar: "teaching_y_trade", coefs, n_obs: 16000, n_entities: 3200, n_times: 5, n_clusters: 75, r2_within: 0.8774,
      depvar_mean: 0.2, depvar_std: 0.1, diagnostics: {}, notes: [], status: "ok", status_reasons: [], support: null,
      cumulative: coef("cumulative", xSum), constant: null, omitted: [], r2: 0.9975, r2_adj: 0.9968, f_stat: 2076.7, f_df: [3, 74], f_p: 0,
      sample_flow: { input_rows: 16000, row_excluded_rows: 0, complete_case_input_rows: 16000, estimation_rows: 16000, dropped_rows_total: 0,
        missing_by_field: {}, missing_by_field_counts_overlap: true, dropped_by_reason: [], years: [2016, 2020] },
      ...extra,
    },
    benchmark: { backend: "x", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "", notes: [] },
    disclaimer: "",
    model_snapshot: { version: options.version } as RegressionResponse["model_snapshot"],
    variable_catalog: [],
  };
}

const macroValues = { teaching_log_gdp: -0.044, teaching_trade_openness: -0.000825 };
const DEFAULT_RUN = response(DEFAULT, { teaching_tariff_exposure: -0.3298, teaching_tariff_exposure_lag1: -0.2206, [ER]: 0.0052, ...macroValues });
const NO_RATE_RUN = response(NO_RATE, { teaching_tariff_exposure: -0.4608, teaching_tariff_exposure_lag1: -0.244, ...macroValues }, { f_df: [2, 74], f_stat: 462.88 });

function experimentOf(spec: ModelSpec, run: RegressionResponse): Experiment {
  return { spec, saved_at: "2026-10-11T09:00:00Z", snapshot: snapshotOf(run) };
}
/** Opens a folded details (the custom form, the full-numbers fold) as a click on its summary would. */
function openDetails(details: Element | null) {
  (details as HTMLDetailsElement).open = true;
  fireEvent(details!, new Event("toggle"));
}

describe("model wording (the server's ModelSpec.summary and equation)", () => {
  test("a spec reads as the report prints it, contained effects dropped", () => {
    expect(specSummary(DEFAULT, options)).toBe("X + L1.X；汇率变动、GDP 对数、贸易开放度；国家×行业 + 年份 FE");
    expect(equationPreview(DEFAULT, options)).toBe("Y = β₁·X + β₂·L1.X + γ₁·汇率变动 + γ₂·GDP 对数 + γ₃·贸易开放度 + 国家×行业 FE + 年份 FE + ε");
    const messy: ModelSpec = {
      x_lags: [2, 0], controls: [{ name: "log_gdp_proxy", lag: 1 }, { name: ER, lag: 0 }],
      fixed_effects: ["year", "country", "country_year", "industry"],
    };
    expect(canonicalSpec(messy, options)).toEqual({
      x_lags: [0, 2], controls: [{ name: ER, lag: 0 }, { name: "log_gdp_proxy", lag: 1 }], fixed_effects: ["industry", "country_year"],
    });
    expect(specSummary(messy, options)).toBe("X + L2.X；汇率变动、L1.增加值总额对数；行业 + 国家×年份 FE");
    expect(equationPreview({ x_lags: [0], controls: [], fixed_effects: [] }, options)).toBe("Y = β₁·X + 常数项 + ε");
    expect(specSummary({ x_lags: [0], controls: [], fixed_effects: [] }, options)).toBe("X；无控制变量；无固定效应");
  });

  test("a combined effect contains its parts", () => {
    expect(effectiveEffects(["country", "country_industry", "year"], options)).toEqual(["country_industry", "year"]);
    expect(includedBy("country", ["country_industry"], options)).toBe("国家×行业 FE");
    expect(includedBy("year", ["country_year"], options)).toBe("国家×年份 FE");
    expect(includedBy("industry", ["country_year"], options)).toBeNull();
  });

  test("terms, stars and p values", () => {
    expect(["teaching_tariff_exposure", "teaching_tariff_exposure_lag2", ER, `${ER}__lag1`, "cumulative", "_constant"].map((name) => termLabel(name, options)))
      .toEqual(["X", "L2.X", "汇率变动", "L1.汇率变动", "X 各项合计（累计效应）", "常数项"]);
    expect([0.005, 0.03, 0.07, 0.2, null].map(significanceStars)).toEqual(["***", "**", "*", "", ""]);
  });
});

describe("experiment labels", () => {
  test("a preset's model is named after the preset; any other model as a custom setting", () => {
    expect(experimentLabel(NO_RATE, options)).toBe("去掉汇率变动");
    expect(experimentLabel({ ...DEFAULT, x_lags: [0] }, options)).toBe("只放当期 X（去掉 L1.X）");
    // Written in another order, it is the same model.
    expect(experimentLabel({ ...NO_RATE, controls: [...NO_RATE.controls].reverse() }, options)).toBe("去掉汇率变动");
    expect(experimentLabel({ x_lags: [0], controls: [], fixed_effects: ["year"] }, options)).toBe("自定义设定");
  });
});

describe("tables", () => {
  const columns: TableColumn[] = [
    { name: "默认模型", spec: DEFAULT, snapshot: snapshotOf(DEFAULT_RUN) },
    { name: "去掉汇率", spec: NO_RATE, snapshot: snapshotOf(NO_RATE_RUN) },
  ];

  test("the design-value row says the course's number per point and each column's deviation from it (v13)", () => {
    const row = designValueRow(columns, "trade", "FVA_share", options)!;
    expect(row.label).toBe("课程设定值（X 每高 1 个百分点）");
    expect(row.cells.every((cell) => cell.startsWith("-0.55 个百分点；估计偏差 "))).toBe(true);
    expect(designValueRow(columns, "production", "3b_FGY_GVC_C_share", options)!.cells[0]).toBe("设定为 0（与 X 无关）");
    expect(designValueRow(columns, "length", "GVCPs", options)!.cells[0]).toBe("无单一设定值（比值 Y）");
    expect(designValueRow(columns, "trade", "unknown", options)).toBeNull();
    expect(designDeviation(-0.66, -0.55)).toBeCloseTo(0.2);
    expect(designDeviation(-0.44, -0.55)).toBeCloseTo(-0.2);
    expect(designDeviation(0.11, -0.55)).toBeCloseTo(-1.2);
    const summary = summaryRows(columns, options);
    expect(summary.map((item) => item.key)).toEqual(expect.arrayContaining(["f_p", "root_mse"]));
  });

  test("the presets are offered in two tiers, 必看 before 进阶, with the design-value note (v13)", () => {
    expect(options.presets.map((item) => item.tier)).toEqual(["core", "core", "core", "advanced", "advanced", "advanced", "advanced"]);
    expect(options.presets.map((item) => item.label)).toEqual([
      "去掉汇率变动", "去掉 GDP 对数", "去掉贸易开放度", "只放当期 X（去掉 L1.X）", "去掉年份固定效应", "固定效应改为国家 + 行业 + 年份", "加上人口增长率和 FDI 净流入占比",
    ]);
    expect(options.x_lags[2].description).toContain("没有两年后的关联");
    expect(options.fixed_effects.find((item) => item.key === "country_year")?.description).toContain("吸收不等于没有控制");
  });

  test("rows are the union of the columns' terms, then each fixed effect and the statistics", () => {
    const rows = coefficientRows(columns, options);
    expect(rows.map((row) => row.label)).toEqual(["X", "L1.X", "汇率变动", "GDP 对数", "贸易开放度", "X 各项合计（累计效应）"]);
    expect(rows[2].cells).toEqual([{ coef: "0.0052***", se: "(0.0005)" }, null]);
    expect(rows[5].cells[1]).toEqual({ coef: "-0.7048***", se: "(0.0705)" });
    const summary = summaryRows(columns, options);
    expect(summary.slice(0, 5).map((row) => [row.label, ...row.cells])).toEqual([
      ["国家 FE", "是", "是"], ["行业 FE", "是", "是"], ["国家×行业 FE", "是", "是"], ["年份 FE", "是", "是"], ["国家×年份 FE", "否", "否"],
    ]);
    expect(summary.find((row) => row.key === "f")?.cells).toEqual(["2,076.70（3, 74）", "462.88（2, 74）"]);
    expect(samplesDiffer(columns)).toBe(false);
  });

  test("one X term has no sum row; no fixed effects shows a constant and no within R²; absorbed terms are said", () => {
    const plainSpec: ModelSpec = { x_lags: [0], controls: [{ name: ER, lag: 1 }], fixed_effects: [] };
    const plain = response(plainSpec, { teaching_tariff_exposure: 0.1, [`${ER}__lag1`]: 0.0005 }, {
      constant: coef("_constant", 0.6), n_obs: 12800, sample_flow: { ...NO_RATE_RUN.result.sample_flow!, years: [2017, 2020] },
    });
    const absorbedSpec: ModelSpec = { x_lags: [0], controls: [{ name: ER, lag: 0 }], fixed_effects: ["country_industry", "country_year"] };
    const absorbed = response(absorbedSpec, { teaching_tariff_exposure: -0.33 }, { omitted: [{ name: ER, reason: "absorbed", by: "国家×年份" }] });
    const both: TableColumn[] = [
      { name: "a", spec: plainSpec, snapshot: snapshotOf(plain) },
      { name: "b", spec: absorbedSpec, snapshot: snapshotOf(absorbed) },
    ];
    const rows = coefficientRows(both, options);
    expect(rows.map((row) => row.label)).toEqual(["X", "汇率变动", "L1.汇率变动", "常数项"]);
    expect(rows[1].cells).toEqual([null, "omitted"]);
    expect(summaryRows(both, options).find((row) => row.key === "r2_within")?.cells).toEqual(["—", "0.8774"]);
    expect(summaryRows(both, options).find((row) => row.key === "years")?.cells).toEqual(["2017–2020", "2016–2020"]);
    expect(samplesDiffer(both)).toBe(true);
    expect(omittedSummary(snapshotOf(absorbed), options)).toEqual(["被国家×年份 FE 吸收：汇率变动"]);
  });

  test("suppressed inference keeps coefficients but drops SE, stars and F", () => {
    const failed = response(NO_RATE, { teaching_tariff_exposure: -0.46, teaching_tariff_exposure_lag1: -0.24 }, { status: "invalid_design" });
    const column: TableColumn = { name: "x", spec: NO_RATE, snapshot: snapshotOf(failed) };
    expect(coefficientRows([column], options)[0].cells[0]).toEqual({ coef: "-0.4600", se: "—" });
    expect(summaryRows([column], options).find((row) => row.key === "f")?.cells).toEqual(["—"]);
  });

  test("the X terms' sum reads per percentage point at the first column's decimals, saying which years it covers", () => {
    const row = perPointRow(columns, "trade")!;
    expect(row.label).toBe("合计：X 每高 1 个百分点");
    expect(row.cells).toEqual(["-0.55 个百分点（两年累计）", "-0.70 个百分点（两年累计）"]);
    // A tight interval would give 3 decimals on its own (-0.554); in the row it takes the first column's 2.
    const tight = response(NO_RATE, { teaching_tariff_exposure: -0.3322, teaching_tariff_exposure_lag1: -0.2222 });
    tight.result.cumulative = { ...coef("cumulative", -0.5544), se: 0.0027, ci_low: -0.5598, ci_high: -0.549 };
    expect(perPointReading("trade", tight.result.cumulative, snapshotOf(tight))).toBe("-0.554 个百分点");
    const xOnly = response({ ...DEFAULT, x_lags: [0] }, { teaching_tariff_exposure: -0.4614, [ER]: 0.0053 });
    const lag2 = response({ ...DEFAULT, x_lags: [0, 1, 2] }, { teaching_tariff_exposure: -0.33, teaching_tariff_exposure_lag1: -0.23, teaching_tariff_exposure_lag2: 0.02, [ER]: 0.005 });
    const mixed = perPointRow([
      columns[0],
      { name: "a", spec: NO_RATE, snapshot: snapshotOf(tight) },
      { name: "b", spec: { ...DEFAULT, x_lags: [0] }, snapshot: snapshotOf(xOnly) },
      { name: "c", spec: { ...DEFAULT, x_lags: [0, 1, 2] }, snapshot: snapshotOf(lag2) },
    ], "trade")!;
    expect(mixed.cells).toEqual(["-0.55 个百分点（两年累计）", "-0.55 个百分点（两年累计）", "-0.46 个百分点（仅当年）", "-0.54 个百分点（三年累计）"]);
    // L1.X dropped from a two-term model: no sum, so the remaining X term is not printed as 两年累计.
    const dropped = response(NO_RATE, { teaching_tariff_exposure: -0.46 }, {
      cumulative: null, omitted: [{ name: "teaching_tariff_exposure_lag1", reason: "collinear", by: null }],
    });
    expect(perPointRow([columns[0], { name: "d", spec: NO_RATE, snapshot: snapshotOf(dropped) }], "trade")!.cells)
      .toEqual(["-0.55 个百分点（两年累计）", ""]);
  });

  test("in the CSV the per-point row sits under the X-terms sum, before a constant, as on the page", () => {
    const plainSpec: ModelSpec = { x_lags: [0, 1], controls: [], fixed_effects: [] };
    const plain = response(plainSpec, { teaching_tariff_exposure: 0.1, teaching_tariff_exposure_lag1: -0.25 }, { constant: coef("_constant", 0.4) });
    const csv = comparisonCsv([columns[0], { name: "无FE", spec: plainSpec, snapshot: snapshotOf(plain) }], options, "Y", perPointRow([columns[0], { name: "无FE", spec: plainSpec, snapshot: snapshotOf(plain) }], "trade"));
    const labels = csv.slice(1).split("\r\n").map((line) => line.split(",")[0]);
    expect(labels.indexOf("合计：X 每高 1 个百分点")).toBe(labels.indexOf("X 各项合计（累计效应）") + 2);
    expect(labels.indexOf("常数项")).toBeGreaterThan(labels.indexOf("合计：X 每高 1 个百分点"));
  });

  test("a wide table scrolls inside its own region: the workbench's grid items may shrink", async () => {
    const css = await Bun.file(new URL("./workbench.css", import.meta.url)).text();
    expect(css).toMatch(/\.reg-custom > \* \{ min-width: 0; \}/);
  });

  test("omitted terms are grouped by why", () => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -0.33 }, { omitted: [
      { name: ER, reason: "absorbed", by: "国家×年份" }, { name: "log_gdp_proxy", reason: "absorbed", by: "国家×年份" },
    ] });
    expect(omittedSummary(snapshotOf(run), options)).toEqual(["被国家×年份 FE 吸收：汇率变动、增加值总额对数"]);
  });

  test("the CSV has a BOM, two rows per term, the fixed effects, the models and the footnote last", () => {
    const named: TableColumn[] = [columns[0], { ...columns[1], name: "本次：去掉汇率变动" }];
    const csv = comparisonCsv(named, options, "外国增加值项占比", perPointRow(named, "trade"));
    expect(csv.startsWith("﻿因变量：外国增加值项占比,默认模型,本次：去掉汇率变动\r\n")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[1]).toBe("X,-0.3298***,-0.4608***");
    // Plain numbers on a labelled row: a spreadsheet reads "(0.0330)" as a negative number.
    expect(lines[2]).toBe("标准误,0.0330,0.0461");
    expect(lines).toContain("国家×年份 FE,否,否");
    expect(lines).toContain("合计：X 每高 1 个百分点,-0.55 个百分点（两年累计）,-0.70 个百分点（两年累计）");
    expect(lines).toContain("F（自由度）,\"2,076.70（3, 74）\",\"462.88（2, 74）\"");
    expect(lines.at(-2)).toBe("设定,X + L1.X；汇率变动、GDP 对数、贸易开放度；国家×行业 + 年份 FE,X + L1.X；GDP 对数、贸易开放度；国家×行业 + 年份 FE");
    expect(options.footnote).toContain("括号内为按国家聚类的标准误");
    expect(lines.at(-1)).toBe(`"${options.footnote.replace("括号内为按国家聚类的标准误", "“标准误”一行为按国家聚类的标准误")}"`);
    expect(csv).not.toMatch(/,\(\d/);
  });
});

describe("report notice", () => {
  test("only the model put into the report counts, as a model", () => {
    const mine = experimentOf(NO_RATE, NO_RATE_RUN);
    const reported = [{ step: 11, name: "去掉汇率变动", outcome: "trade", baseline: "FVA_share", spec: NO_RATE }];
    expect(experimentReportChanged(11, mine, reported, options)).toBe(false);
    expect(experimentReportChanged(11, experimentOf({ ...NO_RATE, x_lags: [0] }, NO_RATE_RUN), reported, options)).toBe(true);
    expect(experimentReportChanged(11, null, reported, options)).toBe(true);
    expect(experimentReportChanged(12, null, reported, options)).toBe(false);
    expect(experimentReportChanged(11, mine, undefined, options)).toBe(true);
  });

  test("the report's copy may list each control's keys in another order (as the database returns it)", () => {
    const withRate = { ...NO_RATE, controls: [{ name: "teaching_exchange_rate_change", lag: 0 }] };
    const mine = experimentOf(withRate, NO_RATE_RUN);
    const fromDatabase = { ...withRate, controls: [{ lag: 0, name: "teaching_exchange_rate_change" }] };
    const reported = [{ step: 11, name: "x", outcome: "trade", baseline: "FVA_share", spec: fromDatabase }];
    expect(experimentReportChanged(11, mine, reported, options)).toBe(false);
    expect(experimentReportChanged(11, mine, [{ ...reported[0], spec: { ...fromDatabase, controls: [{ lag: 1, name: "teaching_exchange_rate_change" }] } }], options)).toBe(true);
  });
});

function Harness({ initial, onSave, onView, locked = false, defaultResponse = DEFAULT_RUN, reported, outdated }: {
  initial?: WorkbenchStepState; onSave?: (patch: Partial<WorkbenchStepState>) => void; locked?: boolean;
  onView?: (patch: Partial<WorkbenchStepState>) => void;
  /** The submitted report's models and whether the report is out of date (step 15's signals). */
  reported?: { step: number; name: string; outcome: string; baseline: string; spec: ModelSpec }[];
  outdated?: boolean;
  /** The step's saved default run (a bar click on the step can change its Y). */
  defaultResponse?: RegressionResponse;
}) {
  const [data, setData] = useState<WorkbenchStepState>(initial ?? {});
  const state: StepStateApi<WorkbenchStepState> = {
    data,
    save: (patch) => { onSave?.(patch); setData((current) => ({ ...current, ...patch })); },
    saveView: (patch) => { onView?.(patch); setData((current) => ({ ...current, ...patch })); },
    complete: false, syncing: false, syncError: null, syncNow: () => {}, materialLocked: locked,
  };
  return <RegressionModelWorkbench stepNumber={11} outcome="trade" defaultResponse={defaultResponse} state={state}
    reportCustomResults={reported as never} reportOutdated={outdated} />;
}

const checkbox = (label: RegExp) => screen.getByRole("checkbox", { name: label });
/** The regression table's column names (the full-numbers fold has a table of its own). */
const tableHeaders = () => [...document.querySelectorAll(".reg-custom-compare-table thead th")].map((cell) => cell.textContent);

describe("the workbench", () => {
  test("a preset runs its model at once and the result joins the table next to the default", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const run = spyOn(api, "runRegression").mockResolvedValue(NO_RATE_RUN as never);
    const views: Partial<WorkbenchStepState>[] = [];
    render(<Harness onView={(patch) => views.push(patch)} />);
    const presets = await screen.findByRole("group", { name: "预设实验" });
    expect([...presets.querySelectorAll("button b")].map((node) => node.textContent)).toEqual(options.presets.map((item) => item.label));
    expect(tableHeaders()).toEqual(["变量", "默认模型"]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^去掉汇率变动/ })); });
    expect(run).toHaveBeenCalledWith("trade", expect.anything(), "FVA_share", NO_RATE);
    // The preset's model is the form's model now (the draft keeps it), and the preset reads pressed.
    expect(views.at(-1)!.custom_draft!.spec).toEqual(NO_RATE);
    expect(screen.getByRole("button", { name: /^去掉汇率变动/ }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "本次：去掉汇率变动"]));
    expect(document.querySelector("th.reg-custom-current")?.textContent).toBe("本次：去掉汇率变动");
    expect(screen.getByRole("button", { name: "把“去掉汇率变动”放入报告" })).toBeTruthy();
  });

  test("the custom form sends the canonical spec; the computed model can be put into the report, replaced and removed", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const run = spyOn(api, "runRegression").mockResolvedValue(NO_RATE_RUN as never);
    const saves: Partial<WorkbenchStepState>[] = [];
    render(<Harness onSave={(patch) => saves.push(patch)} />);
    await screen.findByRole("group", { name: "预设实验" });
    openDetails(document.querySelector(".reg-custom-form-details"));
    await screen.findByText("Y = β₁·X + β₂·L1.X + γ₁·汇率变动 + γ₂·GDP 对数 + γ₃·贸易开放度 + 国家×行业 FE + 年份 FE + ε");
    // 国家×行业 contains 国家 and 行业: shown checked and greyed.
    expect((checkbox(/^国家 FE/) as HTMLInputElement).disabled).toBe(true);
    expect((checkbox(/^国家 FE/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox(/^汇率变动/));
    expect(screen.getByText("Y = β₁·X + β₂·L1.X + γ₁·GDP 对数 + γ₂·贸易开放度 + 国家×行业 FE + 年份 FE + ε")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "计算这个模型" })); });
    expect(run).toHaveBeenCalledWith("trade", expect.anything(), "FVA_share", NO_RATE);
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "本次：去掉汇率变动"]));
    // Into the report: the one model of this step.
    fireEvent.click(screen.getByRole("button", { name: "把“去掉汇率变动”放入报告" }));
    expect(saves).toHaveLength(1);
    expect(saves[0].experiment).toMatchObject({ spec: NO_RATE });
    expect(saves[0].experiment!.snapshot.result.cumulative?.coef).toBeCloseTo(-0.7048);
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "已放入报告：去掉汇率变动"]));
    expect(document.querySelector(".reg-custom-report-chip")?.textContent).toContain("已放入报告：去掉汇率变动");
    expect(screen.queryByRole("button", { name: /放入报告$/ })).toBeNull();
    // Another model computed: it can replace the one in the report; both show until then.
    const xOnly = response({ ...DEFAULT, x_lags: [0] }, { teaching_tariff_exposure: -0.46, [ER]: 0.005, ...macroValues });
    run.mockResolvedValue(xOnly as never);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^只放当期 X/ })); });
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "本次：只放当期 X（去掉 L1.X）", "已放入报告：去掉汇率变动"]));
    fireEvent.click(screen.getByRole("button", { name: "用“只放当期 X（去掉 L1.X）”替换报告里的模型" }));
    expect(saves.at(-1)!.experiment).toMatchObject({ spec: canonicalSpec({ ...DEFAULT, x_lags: [0] }, options) });
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "已放入报告：只放当期 X（去掉 L1.X）"]));
    // Out of the report again.
    fireEvent.click(screen.getByRole("button", { name: "移出报告" }));
    expect(saves.at(-1)).toEqual({ experiment: null });
    await waitFor(() => expect(screen.getByText(/还没有模型放入报告/)).toBeTruthy());
    // Changing the form marks the shown result as out of date.
    fireEvent.click(checkbox(/^L2\.X/));
    expect(screen.getByRole("note").textContent).toContain("设定已更改");
  });

  test("the default model itself cannot be put into the report", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    spyOn(api, "runRegression").mockResolvedValue(DEFAULT_RUN as never);
    render(<Harness />);
    await screen.findByRole("group", { name: "预设实验" });
    openDetails(document.querySelector(".reg-custom-form-details"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "计算这个模型" })); });
    expect(await screen.findByText("这就是本步的默认模型（表中第一列）。")).toBeTruthy();
    expect(document.querySelector("th.reg-custom-current")?.textContent).toBe("默认模型");
    expect(screen.queryByRole("button", { name: /放入报告/ })).toBeNull();
  });

  test("the model in the report is shown on return, and after a submitted report removing it says the report changed", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const reported = [{ step: 11, name: "去掉汇率变动", outcome: "trade", baseline: "FVA_share", spec: NO_RATE }];
    const saves: Partial<WorkbenchStepState>[] = [];
    render(<Harness initial={{ experiment: experimentOf(NO_RATE, NO_RATE_RUN) }} onSave={(patch) => saves.push(patch)} locked reported={reported} outdated />);
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "已放入报告：去掉汇率变动"]));
    expect(screen.getByText(/报告已提交/)).toBeTruthy();
    expect(screen.queryByText(/放入报告的模型与已提交报告里的不同/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移出报告" }));
    expect(saves).toEqual([{ experiment: null }]);
    await waitFor(() => expect(screen.getByText("放入报告的模型与已提交报告里的不同；请到步骤 15 更新报告并重新提交给老师。")).toBeTruthy());
  });

  test("the CSV is the table on screen, with the model just computed", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    spyOn(api, "runRegression").mockResolvedValue(NO_RATE_RUN as never);
    const blobs: Blob[] = [];
    const created = URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob | MediaSource) => { blobs.push(blob as Blob); return "blob:test"; };
    URL.revokeObjectURL = () => {};
    try {
      render(<Harness />);
      await screen.findByRole("group", { name: "预设实验" });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^去掉汇率变动/ })); });
      await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "本次：去掉汇率变动"]));
      openDetails(screen.getByRole("group", { name: "单模型详细数字" }));
      fireEvent.click(screen.getByRole("button", { name: /^导出 CSV/ }));
      const text = await blobs[0].text();
      expect(text.split("\r\n")[0]).toBe("\ufeff因变量：外国增加值项占比,默认模型,本次：去掉汇率变动");
    } finally {
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
    }
  });

  test("leaving the step stops a calculation still running", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    let signal: AbortSignal | undefined;
    spyOn(api, "runRegression").mockImplementation(((_outcome: string, abort: AbortSignal) => {
      signal = abort;
      return new Promise(() => {});
    }) as never);
    const view = render(<Harness />);
    await screen.findByRole("group", { name: "预设实验" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^去掉汇率变动/ })); });
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("the open workbench", () => {
  test("countdown expiry clears only the rate-limit message, not a later calculation failure", async () => {
    let tick: (() => void) | undefined;
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    const interval = window.setInterval.bind(window);
    spyOn(window, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 500) { tick = callback; return 1; }
      return interval(callback, delay);
    }) as typeof window.setInterval);
    spyOn(window, "clearInterval").mockImplementation(() => {});
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const run = spyOn(api, "runRegression").mockRejectedValue(new ApiError(429, "稍后再试", "x", 1) as never);
    render(<Harness />);
    await screen.findByRole("group", { name: "预设实验" });
    openDetails(document.querySelector(".reg-custom-form-details"));
    const compute = screen.getByRole("button", { name: "计算这个模型" });
    fireEvent.click(checkbox(/^汇率变动/));
    await act(async () => { fireEvent.click(compute); });
    expect((await screen.findByRole("alert")).textContent).toContain("计算太频繁");
    run.mockRejectedValue(new ApiError(400, "样本不足", "x") as never);
    await act(async () => { fireEvent.click(compute); });
    clock.mockReturnValue(3000);
    act(() => { tick!(); });
    expect(document.querySelector(".reg-custom-wait")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("样本不足");
  });

  test("too many calculations: new models wait out the countdown, a model computed before can still be computed", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const run = spyOn(api, "runRegression").mockRejectedValue(new ApiError(429, "计算次数过多，请约 5 秒后再试。", "x", 5) as never);
    render(<Harness />);
    await screen.findByRole("group", { name: "预设实验" });
    openDetails(document.querySelector(".reg-custom-form-details"));
    const compute = screen.getByRole("button", { name: "计算这个模型" });
    fireEvent.click(checkbox(/^汇率变动/));
    await act(async () => { fireEvent.click(compute); });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("计算太频繁：每分钟最多算 20 个新模型，新的设定请等倒计时结束；仍在服务器缓存中的设定不计次，现在就能算。");
    expect(alert.textContent).not.toContain("没有算出结果");
    expect(document.querySelector(".reg-custom-wait")?.textContent).toMatch(/^新的设定 \d 秒后可以计算$/);
    // Changing the form during the wait keeps the message next to the countdown.
    fireEvent.click(checkbox(/^增加值总额对数/));
    expect(screen.getByRole("alert").textContent).toContain("计算太频繁");
    // A model computed before: the server answers it from its cache without counting it, so the button still works.
    expect(compute.getAttribute("aria-disabled")).toBeNull();
    run.mockResolvedValue(NO_RATE_RUN as never);
    fireEvent.click(checkbox(/^增加值总额对数/));
    await act(async () => { fireEvent.click(compute); });
    await waitFor(() => expect(tableHeaders()).toContain("本次：去掉汇率变动"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".reg-custom-wait")).not.toBeNull();
  });

  test("changed settings retain and identify the last computed result, even after restoring the default form", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    spyOn(api, "runRegression").mockResolvedValue(NO_RATE_RUN as never);
    render(<Harness />);
    await screen.findByRole("group", { name: "预设实验" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^去掉汇率变动/ })); });
    await waitFor(() => expect(tableHeaders()).toContain("本次：去掉汇率变动"));
    openDetails(document.querySelector(".reg-custom-form-details"));
    fireEvent.click(checkbox(/^L2\.X/));
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("设定已更改，下面保留最近计算的结果；点“计算这个模型”查看新结果。");
    expect(screen.getAllByRole("status").some((node) => node.textContent === "设定已更改，下面保留最近计算的结果；点“计算这个模型”查看新结果。")).toBe(true);
    // The preset no longer reads pressed: the form holds another model.
    expect(screen.getByRole("button", { name: /^去掉汇率变动/ }).getAttribute("aria-pressed")).toBe("false");
    const details = screen.getByRole("group", { name: "单模型详细数字" });
    expect(details.hasAttribute("open")).toBe(true);
    expect(details.textContent).toContain("GDP 对数、贸易开放度");
    expect(details.textContent).toContain("上次计算（设定已更改）");
    expect(details.textContent).toContain("当前设定待重算");
    for (const input of screen.getByRole("group", { name: "关税暴露 X（至少选一项）" }).querySelectorAll<HTMLInputElement>("input:checked")) {
      fireEvent.click(input);
    }
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("下面保留最近计算的结果；请先选择至少一项关税暴露 X，再计算当前设定。");
    expect(screen.getByRole("button", { name: "计算这个模型" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(checkbox(/^L2\.X/));
    expect(document.querySelector(".reg-stale-note")?.textContent).toContain("点“计算这个模型”查看新结果");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认设定" }));
    expect(document.querySelector(".reg-stale-note")?.textContent).toContain("保留最近计算的结果");
  });

  test("it shows the presets from the server, the custom form folded, and the default model's column before anything is computed", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    render(<Harness />);
    const presets = await screen.findByRole("group", { name: "预设实验" });
    expect([...presets.querySelectorAll("button")].map((node) => [node.querySelector("b")?.textContent, node.querySelector("small")?.textContent]))
      .toEqual(options.presets.map((item) => [item.label, item.question]));
    expect(document.querySelector(".reg-custom-form-details")!.hasAttribute("open")).toBe(false);
    expect(tableHeaders()).toEqual(["变量", "默认模型"]);
    expect(document.querySelector(".reg-custom-point-row")?.textContent).toBe("合计：X 每高 1 个百分点-0.55 个百分点（两年累计）");
    expect(screen.getByText(/还没有模型放入报告/)).toBeTruthy();
  });
});

/** The full-numbers fold of one column: the rules the step's old 详细数字 table kept. */
describe("one column's full numbers", () => {
  const column = (spec: ModelSpec, run: RegressionResponse): TableColumn => ({ name: "默认模型", spec, snapshot: snapshotOf(run) });
  const cells = (run: RegressionResponse, outcome: "trade" | "length" | "network" = "trade") => {
    const { container } = render(<ColumnDetails column={column(DEFAULT, run)} options={options} perPoint={(stat, snapshot) => perPointReading(outcome, stat, snapshot)} />);
    const rows = [...container.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
    cleanup();
    return rows;
  };

  test("the sum reads per percentage point at the headline's digits; a length divides by 100", () => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -1.1, teaching_tariff_exposure_lag1: -0.7414, [ER]: 0.0052 });
    run.design.depvar_kind = "length";
    run.result.cumulative = { ...coef("cumulative", -1.8414), ci_low: -1.92, ci_high: -1.76 };
    const sum = cells(run, "length").at(-1)!;
    expect(sum[0]).toBe("X 各项合计（累计效应）");
    expect(sum[1]).toBe("-1.8414");
    expect(sum[5]).toBe("***");
    expect(sum[7]).toBe("-0.0184 个长度单位");
  });

  test("network coefficients group thousands; nothing reads as a negative zero", () => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -2480.37226, teaching_tariff_exposure_lag1: -1600, [ER]: -0.00001 });
    run.design.depvar_kind = "network";
    run.result.coefs[0] = { ...run.result.coefs[0], ci_low: -2558.542, ci_high: -2402.2026, se: 39.88, t: -62.2 };
    run.result.coefs[2] = { ...run.result.coefs[2], coef: -0.00001, se: 0.00001, t: -0.001, ci_low: -0.00004, ci_high: 0.00002 };
    const rows = cells(run, "network");
    expect(rows[0].slice(1, 7)).toEqual(["-2,480.3723", "(39.8800)", "-62.20", "0.0010", "***", "[-2,558.5420, -2,402.2026]"]);
    expect(rows[2][1].startsWith("0.0000")).toBe(true);
    expect(rows[2][6]).toBe("[0.0000, 0.0000]");
  });

  test.each([
    ["unknown status", (run: RegressionResponse) => { run.result.status = null; }],
    ["conflicting support", (run: RegressionResponse) => { run.result.support = { status: "warning", suppress_inference: false } as never; }],
  ])("%s hides p, t, stars and the interval", (_name, change) => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -0.33, teaching_tariff_exposure_lag1: -0.22, [ER]: 0.005 });
    change(run);
    const [first] = cells(run);
    expect(first[1]).toBe("-0.3300");
    expect([first[2], first[3], first[4], first[5]]).toEqual(["—", "—", "—", "—"]);
  });

  test.each([
    [2.7231068455073544e-24, "<0.0001"],
    [0.00009999, "<0.0001"],
    [0.0001, "0.0001"],
    [0.0009587, "0.0010"],
    [0.41, "0.4100"],
  ] as const)("p=%s reads as the report prints it", (p, expected) => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -0.33, teaching_tariff_exposure_lag1: -0.22, [ER]: 0.005 });
    run.result.coefs[0] = { ...run.result.coefs[0], p };
    expect(cells(run)[0][4]).toBe(expected);
  });
});

test("model comparison uses native units, names nonconsecutive lags, and never plots unavailable estimates as zero", () => {
  const native = snapshotOf(response(DEFAULT, { teaching_tariff_exposure: -120, teaching_tariff_exposure_lag1: -60 }));
  native.depvar_kind = "length";
  const absent = { ...native, result: { ...native.result, cumulative: null } };
  const suppressed = { ...native, result: { ...native.result, suppressed: true } };
  render(<ModelComparisonChart outcome="length" columns={[
    { name: "长度模型", spec: { ...DEFAULT, x_lags: [0, 2] }, snapshot: native },
    { name: "无合计", spec: DEFAULT, snapshot: absent },
    { name: "停止模型", spec: DEFAULT, snapshot: suppressed },
  ]} />);
  const image = screen.getByRole("img");
  expect(image.textContent).toContain("-1.80");
  expect(image.textContent).toContain("X + L2.X 之和");
  expect(image.textContent).not.toContain("无合计");
  expect(image.textContent).not.toContain("停止模型");
  expect(screen.getByText(/无合计：.*不绘制对应模型/)).toBeTruthy();
  expect(screen.getByText(/停止模型：停止推断/)).toBeTruthy();
});
