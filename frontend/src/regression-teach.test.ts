import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RegressionEvidenceMatrix,
  familyVerdict,
} from "./regression-teach";
import type { CoefStat, RegressionOutcome, RegressionResponse } from "./types";

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
      depvar_mean: 1, depvar_std: 2, diagnostics: {}, notes: [],
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

  test("prefers the report's qualified run over a later insufficient exploration", () => {
    const qualified = response("trade", coefficient(-0.02, -0.03, -0.01));
    const latest = response("trade", coefficient(-0.02, -0.03, -0.01));
    latest.result.status = "insufficient";
    latest.result.support = {
      treated_clusters: 1, untreated_clusters: 75, treated_entities: 4, untreated_entities: 296,
      total_entities: 300, reversal_entities: [], reversal_share: 0, absorbing: true,
      status: "insufficient", reasons: ["处理支持度不足"], min_treated_clusters: 5,
      max_reversal_share: 0.05, suppress_inference: true,
    };
    latest.result.coefs = [{
      name: "teaching_tariff_exposure", coef: -0.02, se: 0.01, t: 1, p: null, stars: "", ci_low: null, ci_high: null,
    }];
    const verdict = familyVerdict(
      "trade",
      (step: number) => step === 11 ? { run: { design: latest.design, result: latest.result }, qualified_run: { design: qualified.design, result: qualified.result } } : undefined,
    );
    expect(verdict?.state).toBe("negative");
  });

  test("falls back to the qualified sibling run after refresh", () => {
    const saved = response("production", coefficient(0.01, -0.02, 0.04));
    const verdict = familyVerdict(
      "production",
      (step: number) => step === 12 ? { qualified_run: { design: saved.design, result: saved.result } } : undefined,
    );
    expect(verdict?.state).toBe("insufficient");
  });
});

describe("student-first regression reading", () => {
  test("puts all four saved families into one report-ready evidence matrix", () => {
    const trade = response("trade", coefficient(-0.02, -0.03, -0.01));
    const html = renderToStaticMarkup(createElement(RegressionEvidenceMatrix, {
      getStep: (step: number) => step === 11
        ? { qualified_run: { design: trade.design, result: trade.result } }
        : undefined,
    }));
    expect(html).toContain("四步结果汇总");
    expect(html).toContain('aria-label="四步结果汇总表，可横向滚动"');
    expect(html.match(/<th scope="row">/g)).toHaveLength(4);
    expect(html).toContain("下降");
    expect(html).toContain("待估计");
    expect(html).toContain("不同指标的系数不能比大小");
    expect(html).toContain("-0.02 个百分点");
    expect(html).not.toContain("</b><span>百分点</span>");
  });

});
