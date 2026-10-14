import { describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RegressionEvidenceMatrix,
  RegressionSummaryBars,
  ReportedExperiments,
  familyVerdict,
  regressionSummaryRows,
} from "./regression-teach";
import { api } from "./api";
import { snapshotOf } from "./regression-workbench-table";
import optionsFixture from "./regression-workbench-options.fixture.json";
import type { CoefStat, RegressionOutcome, RegressionResponse, WorkbenchOptions } from "./types";

const coefficient = (coef: number, low: number, high: number): CoefStat => ({
  name: "teaching_tariff_exposure", coef, se: 0.01, t: 1, p: 0.2, stars: "", ci_low: low, ci_high: high,
});

function response(outcome: RegressionOutcome, coef: CoefStat): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "Y", granularity: "country_industry", shock_type: "tariff",
      shock_col: "teaching_tariff_exposure", treated_col: "teaching_treated", method: "twfe_intensity", control_mode: "none",
      interaction: false, price_mode: "nominal", scenario: "clean", scenario_label: "基准", sample_filter: "排除ROW",
      exclude_row: true, controls: [], control_labels: {}, equation: "y=x", equation_parts: [], panel_file: "panel_teaching.csv",
      entity: "entity_id", cluster: "country",
    },
    result: {
      depvar: "y", coefs: [coef], n_obs: 10, n_entities: 2, n_times: 5, n_clusters: 2, r2_within: 0.1,
      depvar_mean: 1, depvar_std: 2, depvar_within_std: 2, diagnostics: {}, notes: [],
      status: "ok", status_reasons: [], support: null,
    },
    benchmark: {
      backend: "PanelOLS", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0,
      coef_check_passed: true, se_check_mode: "informational", notes: [],
    },
    disclaimer: "mock",
  };
}

describe("familyVerdict", () => {
  test("reads the step's own saved run", () => {
    const saved = response("trade", coefficient(0.02, 0.01, 0.03));
    const verdict = familyVerdict(
      "trade",
      (step: number) => step === 11 ? { run: { design: saved.design, result: saved.result } } : undefined,
    );
    expect(verdict?.state).toBe("positive");
  });

  for (const outcome of ["trade", "production", "length", "network"] as const) {
    test(`${outcome}: an empty step has no result`, () => {
      expect(familyVerdict(outcome, () => undefined)).toBeNull();
      expect(familyVerdict(outcome, () => ({}))).toBeNull();
      expect(familyVerdict(outcome)).toBeNull();
    });
  }
});

describe("student-first regression reading", () => {
  test("puts all four saved families into one report-ready evidence matrix", () => {
    const trade = response("trade", coefficient(-0.02, -0.03, -0.01));
    const html = renderToStaticMarkup(createElement(RegressionEvidenceMatrix, {
      getStep: (step: number) => step === 11
        ? { run: { design: trade.design, result: trade.result } }
        : undefined,
    }));
    expect(html).toContain("四步结果汇总");
    expect(html).toContain('aria-label="四步结果汇总表，可横向滚动"');
    expect(html.match(/<th scope="row">/g)).toHaveLength(4);
    expect(html).toContain("方向明确：X 越高，Y 越低");
    expect(html).toContain("还没计算");
    expect(html).toContain("四个 Y 的单位不同，数字不能直接比较大小");
    expect(html).not.toMatch(/TWFE|处理前|标称/);
    expect(html).toContain("-0.020 个百分点");
    expect(html).not.toContain("</b><span>百分点</span>");
    // The column names the association, as the step pages do.
    expect(html).toContain("<th>X 每高 1 个百分点，Y 两年累计平均相差</th><th>其中当年 / 次年</th>");
  });

  test("a saved run of the course model shows its cumulative relation and its split over the two years", () => {
    // Teaching data v10: X and L1.X; the headline is their sum.
    const run = response("trade", coefficient(-0.33, -0.35, -0.31));
    run.result.coefs = [
      { ...run.result.coefs[0] },
      { ...run.result.coefs[0], name: "teaching_tariff_exposure_lag1", coef: -0.22, ci_low: -0.24, ci_high: -0.2 },
    ];
    run.result.cumulative = { ...run.result.coefs[0], name: "cumulative", coef: -0.55, ci_low: -0.57, ci_high: -0.53 };
    const html = renderToStaticMarkup(createElement(RegressionEvidenceMatrix, {
      getStep: (step: number) => step === 11 ? { run: { design: run.design, result: run.result } } : undefined,
    }));
    const dom = new DOMParser().parseFromString(html, "text/html");
    const cells = [...[...dom.querySelectorAll("tbody tr")][0].querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells[2]).toBe("-0.55 个百分点");
    expect(cells[3]).toBe("-0.33 个百分点 / -0.22 个百分点");
    expect(cells[4]).toBe("[-0.57, -0.53] 个百分点");
  });

  test("a weak Y whose interval includes 0 reads 方向不确定 with its signed estimate and interval", () => {
    // Like a production Y generated with no relation to X: the interval spans 0.
    const weak = response("production", coefficient(0.3, -1.2, 1.8));
    weak.design.baseline = "3b_FGY_GVC_C_share";
    weak.design.baseline_label = "后向复杂 GVC 生产份额";
    weak.design.depvar_kind = "share";
    const html = renderToStaticMarkup(createElement(RegressionEvidenceMatrix, {
      getStep: (step: number) => step === 12 ? { run: { design: weak.design, result: weak.result } } : undefined,
    }));
    const dom = new DOMParser().parseFromString(html, "text/html");
    const row = [...dom.querySelectorAll("tbody tr")].find((item) => item.querySelector("th")?.textContent === "12")!;
    const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells[0]).toContain("后向复杂 GVC 生产份额");
    expect(cells[1]).toBe("方向不确定");
    expect(cells[2]).toBe("+0.30 个百分点");
    // A single-X run has no year split.
    expect(cells[3]).toBe("—");
    expect(cells[4]).toBe("[-1.20, +1.80] 个百分点");
    expect(html).not.toMatch(/方向明确|平均高|平均低/);
  });

  test("steps 13 and 14 state their size the same way, in standard deviations, defined once", () => {
    const length = response("length", coefficient(-1.8414, -1.92, -1.76));
    length.design.depvar_kind = "length";
    length.result.depvar_within_std = 0.58;
    const network = response("network", coefficient(-4010.7, -4109.84, -3911.56));
    network.design.depvar_kind = "network";
    network.result.depvar_within_std = 856;
    const html = renderToStaticMarkup(createElement(RegressionEvidenceMatrix, {
      getStep: (step: number) => step === 13 ? { run: { design: length.design, result: length.result } }
        : step === 14 ? { run: { design: network.design, result: network.result } } : undefined,
    }));
    const dom = new DOMParser().parseFromString(html, "text/html");
    const effect = (step: string) => [...dom.querySelectorAll("tbody tr")].find((item) => item.querySelector("th")?.textContent === step)!
      .querySelectorAll("td")[2].textContent;
    // At 3 decimals the interval's upper end would read as the estimate ("-0.018" in "[-0.019, -0.018]"): one more.
    expect(effect("13")).toBe("-0.0184 个长度单位（幅度约 0.032 个标准差）");
    expect([...dom.querySelectorAll("tbody tr")].find((item) => item.querySelector("th")?.textContent === "13")!
      .querySelectorAll("td")[4].textContent).toMatch(/^\[-0\.0192, -0\.0176\] 个长度单位/);
    expect(effect("14")).toBe("-40.11 个中心性原始单位（幅度约 0.047 个标准差）");
    expect(html).not.toContain("样本均值");
    expect(html.match(/标准差指扣除各国家×行业自身水平和各年共同变化后 Y 的起伏/g)).toHaveLength(1);
  });

});

describe("RegressionSummaryBars", () => {
  test("draws one standardized bar per saved step, named after the Y that step ran, with its native value", () => {
    const trade = response("trade", coefficient(0.5, 0.4, 0.6));
    trade.design.baseline = "DVAex_share";
    trade.design.baseline_label = "国内增加值出口占比";
    trade.design.depvar_kind = "share";
    trade.result.depvar_within_std = 0.1;
    const length = response("length", coefficient(-0.4, -0.5, -0.3));
    length.design.baseline = "GVCPs";
    length.design.baseline_label = "GVC 位置指数";
    length.design.depvar_kind = "position";
    length.result.depvar_within_std = 0.2;
    const getStep = (step: number) => step === 11 ? { run: { design: trade.design, result: trade.result } }
      : step === 13 ? { run: { design: length.design, result: length.result } } : undefined;
    const { rows, missing } = regressionSummaryRows(getStep);
    // (β × 0.01) / sd(Y): 0.5 × 0.01 / 0.1 = 0.05 and -0.4 × 0.01 / 0.2 = -0.02.
    expect(rows.map((row) => [row.label, row.sublabel, row.value.toFixed(6), row.valueLabel, row.uncertain])).toEqual([
      ["国内增加值出口占比", "步骤 11 · 贸易流", "0.050000", "+0.50 个百分点（+0.050 个标准差）", false],
      ["GVC 位置指数", "步骤 13 · 长度", "-0.020000", "-0.0040（-0.020 个标准差）", false],
    ]);
    expect(missing).toEqual(["步骤 12 · 生产", "步骤 14 · 网络"]);
    const html = renderToStaticMarkup(createElement(RegressionSummaryBars, { getStep }));
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll("[data-bar]")).toHaveLength(2);
    expect(dom.querySelector("svg")?.getAttribute("role")).toBe("img");
    expect(html).toContain("X 每高 1 个百分点，Y 两年累计平均相差（个标准差）");
    expect(dom.querySelector(".reg-family-missing")?.textContent).toBe("步骤 12 · 生产、步骤 14 · 网络：还没计算");
  });

  test("a course-model run without its two-year sum (L1.X dropped) has no estimate, not its X alone", () => {
    const trade = response("trade", coefficient(-0.33, -0.35, -0.31));
    trade.design.spec = { x_lags: [0, 1], controls: [], fixed_effects: ["country_industry", "year"] };
    trade.result.cumulative = null;
    const { rows } = regressionSummaryRows((step: number) => step === 11 ? { run: { design: trade.design, result: trade.result } } : undefined);
    expect(rows.map((row) => row.valueLabel)).toEqual(["没算出估计值"]);
    // A single-X model keeps its X as the headline.
    trade.design.spec = { x_lags: [0], controls: [], fixed_effects: ["country_industry", "year"] };
    expect(regressionSummaryRows((step: number) => step === 11 ? { run: { design: trade.design, result: trade.result } } : undefined)
      .rows.map((row) => row.valueLabel)).toEqual(["-0.33 个百分点（-0.0017 个标准差）"]);
  });
});

describe("ReportedExperiments", () => {
  const withSum = (value: number, low: number, high: number) => {
    const run = response("trade", coefficient(value, low, high));
    run.design.baseline = "FVA_share";
    run.design.depvar_kind = "share";
    run.result.cumulative = { ...coefficient(value, low, high), name: "cumulative" };
    return run;
  };
  const noRateSpec = { x_lags: [0, 1], controls: [{ name: "teaching_log_gdp", lag: 0 }, { name: "teaching_trade_openness", lag: 0 }], fixed_effects: ["country_industry", "year"] };

  test("lists each step's experiment, named after its preset, with its sum next to the step's default model", async () => {
    const defaultRun = withSum(-0.55, -0.57, -0.53);
    const noRate = withSum(-0.70, -0.75, -0.65);
    const options = spyOn(api, "regressionOptions").mockResolvedValue(optionsFixture as WorkbenchOptions);
    try {
      const view = render(createElement(ReportedExperiments, {
        getStep: (step: number) => step === 11
          ? { run: { design: defaultRun.design, result: defaultRun.result }, experiment: { spec: noRateSpec, saved_at: "2026-10-14", snapshot: snapshotOf(noRate) } }
          : step === 12 ? { run: { design: defaultRun.design, result: defaultRun.result }, experiment: null } : undefined,
      }));
      await waitFor(() => expect(view.container.querySelector("tbody tr td b")?.textContent).toBe("去掉汇率变动"));
      const rows = [...view.container.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
      expect(rows).toHaveLength(1);
      expect(rows[0][0]).toBe("步骤 11 · 贸易流");
      expect(rows[0][2]).toContain("X + L1.X；GDP 对数、贸易开放度；国家×行业 + 年份 FE");
      // The model's sum says which years it covers; both read at the default's decimals.
      expect(rows[0][3]).toBe("-0.70 个百分点（两年累计）");
      expect(rows[0][4]).toBe("-0.55 个百分点");
    } finally { cleanup(); options.mockRestore(); }
  });

  test("discloses selected controls omitted from the actual saved estimate", async () => {
    const run = withSum(-0.55, -0.57, -0.53);
    run.result.omitted = [{ name: "teaching_exchange_rate_change", reason: "absorbed", by: "国家×年份" }];
    const experiment = {
      saved_at: "2026-10-13",
      spec: { x_lags: [0, 1], controls: [{ name: "teaching_exchange_rate_change", lag: 0 }], fixed_effects: ["country_year"] },
      snapshot: snapshotOf(run),
    };
    const options = spyOn(api, "regressionOptions").mockResolvedValue(optionsFixture as WorkbenchOptions);
    try {
      const view = render(createElement(ReportedExperiments, {
        getStep: (step: number) => step === 11 ? { run, experiment } : undefined,
      }));
      await waitFor(() => expect(view.container.textContent).toContain("被国家×年份 FE 吸收：汇率变动"));
      // Not a preset: named as a custom setting.
      expect(view.container.querySelector("tbody tr td b")?.textContent).toStartWith("自定义设定：");
    } finally { cleanup(); options.mockRestore(); }
  });

  test("says how to add one when none is marked", () => {
    const html = renderToStaticMarkup(createElement(ReportedExperiments, { getStep: () => undefined }));
    expect(html).toContain("还没有放入报告的模型实验（选做）");
    expect(html).not.toContain("<table");
  });
});

test("the step-15 summary table gives each of its seven columns a share of the width", async () => {
  // With table-layout: fixed, a column left out of the shares gets 0 px and wraps one character per line.
  const css = await Bun.file(new URL("./workbench.css", import.meta.url)).text();
  const widths = [...css.matchAll(/\.reg-evidence-table th:nth-child\((\d)\)[^{]*\{ width: (\d+)%; \}/g)]
    .map((match) => [Number(match[1]), Number(match[2])] as const);
  expect(widths.map(([column]) => column)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(widths.reduce((total, [, width]) => total + width, 0)).toBe(100);
  expect(widths.every(([, width]) => width > 0)).toBe(true);
});
