import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { api, ApiError } from "./api";
import { ColumnDetails, customReportChanged, RegressionModelWorkbench, type WorkbenchStepState } from "./regression-workbench";
import {
  canonicalSpec, coefficientRows, comparisonCsv, effectiveEffects, equationPreview, includedBy, nameProblem, omittedSummary, perPointReading, perPointRow,
  nextResultName, omittedLines, samplesDiffer, significanceStars, snapshotOf, specSummary, summaryRows, termLabel,
  type TableColumn,
} from "./regression-workbench-table";
import optionsFixture from "./regression-workbench-options.fixture.json";
import type { CoefStat, CustomResult, ModelSpec, RegressionResponse, StepStateApi, WorkbenchOptions } from "./types";

afterEach(() => { cleanup(); mock.restore(); });

const options = optionsFixture as WorkbenchOptions;
const ER = "teaching_exchange_rate_change";
const DEFAULT: ModelSpec = options.default_spec;
const NO_RATE: ModelSpec = { x_lags: [0, 1], controls: [], fixed_effects: ["country_industry", "year"] };

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

const DEFAULT_RUN = response(DEFAULT, { teaching_tariff_exposure: -0.3298, teaching_tariff_exposure_lag1: -0.2206, [ER]: 0.0052 });
const NO_RATE_RUN = response(NO_RATE, { teaching_tariff_exposure: -0.4608, teaching_tariff_exposure_lag1: -0.244 }, { f_df: [2, 74], f_stat: 462.88 });

function saved(name: string, spec: ModelSpec, run: RegressionResponse, change: Partial<CustomResult> = {}): CustomResult {
  return {
    id: `id-${name}`, name, outcome: "trade", baseline: "FVA_share", spec, in_report: false, saved_at: "2026-10-11T09:00:00Z",
    snapshot: snapshotOf(run), ...change,
  };
}

describe("model wording (the server's ModelSpec.summary and equation)", () => {
  test("a spec reads as the report prints it, contained effects dropped", () => {
    expect(specSummary(DEFAULT, options)).toBe("X + L1.X；汇率变动；国家×行业 + 年份 FE");
    expect(equationPreview(DEFAULT, options)).toBe("Y = β₁·X + β₂·L1.X + γ₁·汇率变动 + 国家×行业 FE + 年份 FE + ε");
    const messy: ModelSpec = {
      x_lags: [2, 0], controls: [{ name: "log_gdp_proxy", lag: 1 }, { name: ER, lag: 0 }],
      fixed_effects: ["year", "country", "country_year", "industry"],
    };
    expect(canonicalSpec(messy, options)).toEqual({
      x_lags: [0, 2], controls: [{ name: ER, lag: 0 }, { name: "log_gdp_proxy", lag: 1 }], fixed_effects: ["industry", "country_year"],
    });
    expect(specSummary(messy, options)).toBe("X + L2.X；汇率变动、L1.GDP（取对数）；行业 + 国家×年份 FE");
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

describe("names", () => {
  test("the next default name follows the largest number, and names are checked", () => {
    expect(nextResultName([])).toBe("结果1");
    expect(nextResultName([{ name: "结果1" }, { name: "去掉汇率" }])).toBe("结果3");
    expect(nextResultName([{ name: "结果5" }])).toBe("结果6");
    const list = [{ id: "a", name: "结果1" }];
    expect(nameProblem("  ", list, 20)).toBe("请输入名称");
    expect(nameProblem("一".repeat(21), list, 20)).toBe("名称最多 20 个字符");
    expect(nameProblem("结果1", list, 20)).toBe("本步已有名为“结果1”的模型");
    expect(nameProblem("结果1", list, 20, "a")).toBeNull();
    // Invisible characters: the server refuses them, and JavaScript's trim would keep some Python strips (U+001F).
    for (const name of ["\u200b", "结果\u202e1", "结果\u001f", "结\u2028果"]) {
      expect(nameProblem(name, list, 20)).toBe("名称不能包含不可见字符");
    }
  });
});

describe("tables", () => {
  const columns: TableColumn[] = [
    { name: "默认模型", spec: DEFAULT, snapshot: snapshotOf(DEFAULT_RUN) },
    { name: "去掉汇率", spec: NO_RATE, snapshot: snapshotOf(NO_RATE_RUN) },
  ];

  test("rows are the union of the columns' terms, then each fixed effect and the statistics", () => {
    const rows = coefficientRows(columns, options);
    expect(rows.map((row) => row.label)).toEqual(["X", "L1.X", "汇率变动", "X 各项合计（累计效应）"]);
    expect(rows[2].cells).toEqual([{ coef: "0.0052***", se: "(0.0005)" }, null]);
    expect(rows[3].cells[1]).toEqual({ coef: "-0.7048***", se: "(0.0705)" });
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
    expect(omittedLines(snapshotOf(absorbed), options)).toEqual(["汇率变动：被国家×年份 FE 吸收"]);
  });

  test("suppressed inference keeps coefficients and SE but drops the stars and F", () => {
    const failed = response(NO_RATE, { teaching_tariff_exposure: -0.46, teaching_tariff_exposure_lag1: -0.24 }, { status: "invalid_design" });
    const column: TableColumn = { name: "x", spec: NO_RATE, snapshot: snapshotOf(failed) };
    expect(coefficientRows([column], options)[0].cells[0]).toEqual({ coef: "-0.4600", se: "(0.0460)" });
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
    expect(omittedSummary(snapshotOf(run), options)).toEqual(["被国家×年份 FE 吸收：汇率变动、GDP（取对数）"]);
  });

  test("in the CSV only typed names are kept from reading as formulas; the table's signed numbers stay as they are", () => {
    const flipped = response(NO_RATE, { teaching_tariff_exposure: 0.4608, teaching_tariff_exposure_lag1: 0.244 });
    const named: TableColumn[] = [columns[0], { name: "-2+3+cmd", spec: NO_RATE, snapshot: snapshotOf(flipped) }];
    const csv = comparisonCsv(named, options, "Y", perPointRow(named, "trade"));
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe("因变量：Y,默认模型,'-2+3+cmd");
    const perPoint = lines.find((line) => line.startsWith("合计：X 每高 1 个百分点"))!;
    expect(perPoint).toBe("合计：X 每高 1 个百分点,-0.55 个百分点（两年累计）,+0.70 个百分点（两年累计）");
    expect(csv).not.toContain(",'+");
  });

  test("the CSV has a BOM, two rows per term, the fixed effects, the models and the footnote last", () => {
    const named: TableColumn[] = [columns[0], { ...columns[1], name: "=SUM(1,2)" }];
    const csv = comparisonCsv(named, options, "外国增加值项占比", perPointRow(named, "trade"));
    expect(csv.startsWith("﻿因变量：外国增加值项占比,默认模型,\"'=SUM(1,2)\"\r\n")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines[1]).toBe("X,-0.3298***,-0.4608***");
    expect(lines[2]).toBe(",(0.0330),(0.0461)");
    expect(lines).toContain("国家×年份 FE,否,否");
    expect(lines).toContain("合计：X 每高 1 个百分点,-0.55 个百分点（两年累计）,-0.70 个百分点（两年累计）");
    expect(lines).toContain("F（自由度）,\"2,076.70（3, 74）\",\"462.88（2, 74）\"");
    expect(lines.at(-2)).toBe("设定,X + L1.X；汇率变动；国家×行业 + 年份 FE,X + L1.X；无控制变量；国家×行业 + 年份 FE");
    expect(lines.at(-1)).toBe(`"${options.footnote}"`);
  });
});

describe("report notice", () => {
  test("only the models marked for the report, by name, Y and model, count", () => {
    const a = saved("去掉汇率", NO_RATE, NO_RATE_RUN, { in_report: true });
    const b = saved("结果2", DEFAULT, DEFAULT_RUN);
    const reported = [{ step: 11, name: "去掉汇率", outcome: "trade", baseline: "FVA_share", spec: NO_RATE }];
    expect(customReportChanged(11, [a, b], reported)).toBe(false);
    expect(customReportChanged(11, [{ ...a, name: "改了名" }, b], reported)).toBe(true);
    expect(customReportChanged(11, [a, { ...b, in_report: true }], reported)).toBe(true);
    expect(customReportChanged(12, [], reported)).toBe(false);
    expect(customReportChanged(11, [a], undefined)).toBe(true);
  });

  test("the report's copy may list each control's keys in another order (as the database returns it)", () => {
    const withRate = { ...NO_RATE, controls: [{ name: "teaching_exchange_rate_change", lag: 0 }] };
    const a = saved("国家年份", withRate, NO_RATE_RUN, { in_report: true });
    const fromDatabase = { ...withRate, controls: [{ lag: 0, name: "teaching_exchange_rate_change" }] };
    const reported = [{ step: 11, name: "国家年份", outcome: "trade", baseline: "FVA_share", spec: fromDatabase }];
    expect(customReportChanged(11, [a], reported)).toBe(false);
    expect(customReportChanged(11, [a], [{ ...reported[0], spec: { ...fromDatabase, controls: [{ lag: 1, name: "teaching_exchange_rate_change" }] } }])).toBe(true);
  });
});

function Harness({ initial, onSave, onView, locked = false, defaultResponse = DEFAULT_RUN }: {
  initial?: WorkbenchStepState; onSave?: (patch: Partial<WorkbenchStepState>) => void; locked?: boolean;
  onView?: (patch: Partial<WorkbenchStepState>) => void;
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
  return <RegressionModelWorkbench stepNumber={11} outcome="trade" defaultResponse={defaultResponse} state={state} />;
}

const checkbox = (label: RegExp) => screen.getByRole("checkbox", { name: label });
/** The regression table's column names (the full-numbers fold has a table of its own). */
const tableHeaders = () => [...document.querySelectorAll(".reg-custom-compare-table thead th")].map((cell) => cell.textContent);

describe("the workbench", () => {
  test("the form sends the canonical spec, and the computed model can be saved once under a checked name", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const run = spyOn(api, "runRegression").mockResolvedValue(NO_RATE_RUN as never);
    const saves: Partial<WorkbenchStepState>[] = [];
    render(<Harness onSave={(patch) => saves.push(patch)} />);
    await screen.findByText("Y = β₁·X + β₂·L1.X + γ₁·汇率变动 + 国家×行业 FE + 年份 FE + ε");
    // 国家×行业 contains 国家 and 行业: shown checked and greyed.
    expect((checkbox(/^国家 FE/) as HTMLInputElement).disabled).toBe(true);
    expect((checkbox(/^国家 FE/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox(/^汇率变动/));
    expect(screen.getByText("Y = β₁·X + β₂·L1.X + 国家×行业 FE + 年份 FE + ε")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "计算这个模型" })); });
    expect(run).toHaveBeenCalledWith("trade", expect.anything(), "FVA_share", NO_RATE);
    // The computed model joins the one table, highlighted, after the default model.
    await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "本次计算（未保存）"]));
    expect(document.querySelector("th.reg-custom-current")?.textContent).toBe("本次计算（未保存）");
    expect((screen.getByLabelText(/保存为/) as HTMLInputElement).value).toBe("结果1");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(saves).toHaveLength(1);
    const [item] = saves[0].custom_results!;
    expect(item).toMatchObject({ name: "结果1", outcome: "trade", baseline: "FVA_share", spec: NO_RATE, in_report: false });
    expect(item.snapshot.result.cumulative?.coef).toBeCloseTo(-0.7048);
    // Saved once: the same model is not offered again, and it joins the comparison.
    expect(await screen.findByText("这个设定已保存为“结果1”。")).toBeTruthy();
    expect(tableHeaders()).toContain("结果1");
    expect(screen.queryByRole("columnheader", { name: "本次计算（未保存）" })).toBeNull();
    expect(document.querySelector("th.reg-custom-current")?.textContent).toBe("结果1");
    // Changing the form marks the shown result as out of date.
    fireEvent.click(checkbox(/^L2\.X/));
    expect(screen.getByText(/设定已更改/)).toBeTruthy();
  });

  test("the default model itself is not saved again", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    spyOn(api, "runRegression").mockResolvedValue(DEFAULT_RUN as never);
    render(<Harness />);
    const compute = await screen.findByRole("button", { name: "计算这个模型" });
    await act(async () => { fireEvent.click(compute); });
    expect(await screen.findByText("这就是本步的默认模型（表中第一列），不用另存。")).toBeTruthy();
    expect(document.querySelector("th.reg-custom-current")?.textContent).toBe("默认模型");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  test("at most three go into the report; another Y cannot be compared; deleting asks first", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const list = [
      saved("结果1", NO_RATE, NO_RATE_RUN, { in_report: true }),
      saved("结果2", { ...NO_RATE, x_lags: [0] }, NO_RATE_RUN, { in_report: true }),
      saved("结果3", { ...NO_RATE, x_lags: [1] }, NO_RATE_RUN, { in_report: true }),
      saved("结果4", { ...NO_RATE, x_lags: [2] }, NO_RATE_RUN, { baseline: "DVAex_share" }),
    ];
    const saves: Partial<WorkbenchStepState>[] = [];
    render(<Harness initial={{ custom_results: list }} onSave={(patch) => saves.push(patch)} locked />);
    await screen.findByText("已保存的模型（4/6）");
    expect((checkbox(/把 结果4 放入报告/) as HTMLInputElement).disabled).toBe(true);
    expect((checkbox(/对比 结果4/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/报告已提交/)).toBeTruthy();
    fireEvent.click(checkbox(/把 结果1 放入报告/));
    expect(saves.at(-1)!.custom_results!.filter((item) => item.in_report).map((item) => item.name)).toEqual(["结果2", "结果3"]);
    await waitFor(() => expect((checkbox(/把 结果4 放入报告/) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(await screen.findByText("删除“结果1”？")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "删除" }).at(-1)!);
    expect(saves.at(-1)!.custom_results!.map((item) => item.name)).toEqual(["结果2", "结果3", "结果4"]);
  });

  test("after a rename or a delete, focus moves to what replaced the button", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    render(<Harness initial={{ custom_results: [saved("结果1", NO_RATE, NO_RATE_RUN), saved("结果2", { ...NO_RATE, x_lags: [0] }, NO_RATE_RUN)] }} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "改名" }))[0]);
    fireEvent.change(screen.getByLabelText("新名称"), { target: { value: "去掉汇率" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("改名"));
    expect(document.activeElement?.closest("tr")?.textContent).toContain("去掉汇率");
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    fireEvent.click((await screen.findAllByRole("button", { name: "删除" })).at(-1)!);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("已保存的模型（1/6）"));
  });

  test("compare choices made while another Y was saved are kept", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const views: Partial<WorkbenchStepState>[] = [];
    const list = [
      saved("结果1", NO_RATE, NO_RATE_RUN),
      saved("结果2", { ...NO_RATE, x_lags: [0] }, NO_RATE_RUN),
      saved("别的Y", { ...NO_RATE, x_lags: [1] }, NO_RATE_RUN, { baseline: "DVAex_share" }),
    ];
    render(<Harness initial={{ custom_results: list, custom_draft: { compare: [list[0].id, list[2].id] } }} onView={(patch) => views.push(patch)} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /对比 结果2/ }));
    expect(views.at(-1)!.custom_draft!.compare).toEqual([list[2].id, list[0].id, list[1].id]);
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
      const compute = await screen.findByRole("button", { name: "计算这个模型" });
      fireEvent.click(checkbox(/^汇率变动/));
      await act(async () => { fireEvent.click(compute); });
      await waitFor(() => expect(tableHeaders()).toEqual(["变量", "默认模型", "本次计算（未保存）"]));
      fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
      const text = await blobs[0].text();
      expect(text.split("\r\n")[0]).toBe("\ufeff因变量：外国增加值项占比,默认模型,本次计算（未保存）");
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
    const compute = await screen.findByRole("button", { name: "计算这个模型" });
    await act(async () => { fireEvent.click(compute); });
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  test("renaming checks the name in this step", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    const saves: Partial<WorkbenchStepState>[] = [];
    render(<Harness initial={{ custom_results: [saved("结果1", NO_RATE, NO_RATE_RUN), saved("结果2", DEFAULT, DEFAULT_RUN)] }} onSave={(patch) => saves.push(patch)} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "改名" }))[0]);
    fireEvent.change(screen.getByLabelText("新名称"), { target: { value: "结果2" } });
    expect(screen.getByText("本步已有名为“结果2”的模型")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(saves).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("新名称"), { target: { value: " 去掉汇率 " } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(saves[0].custom_results!.map((item) => item.name)).toEqual(["去掉汇率", "结果2"]);
  });
});

describe("the open workbench", () => {
  test("too many calculations: a countdown on the button and a message that is not about the model", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    spyOn(api, "runRegression").mockRejectedValue(new ApiError(429, "计算次数过多，请约 5 秒后再试。", "x", 5) as never);
    render(<Harness />);
    const compute = await screen.findByRole("button", { name: "计算这个模型" });
    fireEvent.click(checkbox(/^汇率变动/));
    await act(async () => { fireEvent.click(compute); });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("计算太频繁：每分钟最多算 20 个新模型（已经算过的不计），请稍等再算。");
    const waiting = screen.getByRole("button", { name: /^重试（\d 秒后）$/ });
    expect(waiting.getAttribute("aria-disabled")).toBe("true");
    expect(alert.textContent).not.toContain("没有算出结果");
    // Changing the form during the wait keeps the message next to the countdown.
    fireEvent.click(checkbox(/^GDP/));
    expect(screen.getByRole("alert").textContent).toContain("计算太频繁");
  });

  test("out of date: said when the form changed, named when the Y changed, silent when the form is back at the default", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    spyOn(api, "runRegression").mockResolvedValue(NO_RATE_RUN as never);
    const { rerender } = render(<Harness />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /^汇率变动/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "计算这个模型" })); });
    await waitFor(() => expect(tableHeaders()).toContain("本次计算（未保存）"));
    fireEvent.click(checkbox(/^L2\.X/));
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("设定已更改，点“计算这个模型”查看新结果。");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认设定" }));
    expect(document.querySelector(".reg-stale-note")).toBeNull();
    // Another Y saved by the bars: the note names it.
    const other = response(DEFAULT, { teaching_tariff_exposure: 0.33, teaching_tariff_exposure_lag1: 0.22, [ER]: -0.005 }, {}, "DVAex_share");
    other.design.depvar_label = "国内增加值出口占比";
    rerender(<Harness defaultResponse={other} />);
    fireEvent.click(checkbox(/^汇率变动/));
    expect(document.querySelector(".reg-stale-note")?.textContent).toBe("因变量已换成“国内增加值出口占比”，点“计算这个模型”在新的 Y 上计算。");
  });

  test("it shows the four tries from the server and the default model's column before anything is computed", async () => {
    spyOn(api, "regressionOptions").mockResolvedValue(options);
    render(<Harness />);
    await screen.findByText(/试一试/);
    expect([...document.querySelectorAll(".reg-custom-tries li")].map((item) => item.textContent)).toEqual(options.tries);
    expect(tableHeaders()).toEqual(["变量", "默认模型"]);
    expect(document.querySelector(".reg-custom-point-row")?.textContent).toBe("合计：X 每高 1 个百分点-0.55 个百分点（两年累计）");
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
    expect(sum[1]).toBe("-1.8414***");
    expect(sum[6]).toBe("-0.0184 个长度单位");
  });

  test("network coefficients group thousands; nothing reads as a negative zero", () => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -2480.37226, teaching_tariff_exposure_lag1: -1600, [ER]: -0.00001 });
    run.design.depvar_kind = "network";
    run.result.coefs[0] = { ...run.result.coefs[0], ci_low: -2558.542, ci_high: -2402.2026, se: 39.88, t: -62.2 };
    run.result.coefs[2] = { ...run.result.coefs[2], coef: -0.00001, se: 0.00001, t: -0.001, ci_low: -0.00004, ci_high: 0.00002 };
    const rows = cells(run, "network");
    expect(rows[0].slice(1, 6)).toEqual(["-2,480.3723***", "(39.8800)", "-62.20", "0.0010", "[-2,558.5420, -2,402.2026]"]);
    expect(rows[2][1].startsWith("0.0000")).toBe(true);
    expect(rows[2][5]).toBe("[0.0000, 0.0000]");
  });

  test.each([
    ["unknown status", (run: RegressionResponse) => { run.result.status = null; }],
    ["conflicting support", (run: RegressionResponse) => { run.result.support = { status: "warning", suppress_inference: false } as never; }],
  ])("%s hides p, t, stars and the interval", (_name, change) => {
    const run = response(DEFAULT, { teaching_tariff_exposure: -0.33, teaching_tariff_exposure_lag1: -0.22, [ER]: 0.005 });
    change(run);
    const [first] = cells(run);
    expect(first[1]).toBe("-0.3300");
    expect([first[3], first[4], first[5]]).toEqual(["—", "—", "—"]);
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
