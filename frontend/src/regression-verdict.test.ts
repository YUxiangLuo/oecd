import { describe, expect, test } from "bun:test";
import {
  buildRegressionVerdict, chartDisplayScale, REGRESSION_STATUS_LABELS, regressionStatusLabel,
} from "./regression-verdict";
import type { CoefStat, RegressionOutcome, RegressionResponse, TreatmentSupport } from "./types";

const coefficient = (coef: number, low: number | null, high: number | null): CoefStat => ({
  name: "teaching_tariff_exposure", coef, se: 0.01, t: 1, p: low == null ? null : 0.2,
  stars: "", ci_low: low, ci_high: high,
});

function response(outcome: RegressionOutcome, coef: CoefStat, support: TreatmentSupport | null = null): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "Y", granularity: "country_industry", shock_type: "tariff",
      shock_col: "teaching_tariff_exposure", treated_col: "teaching_treated", method: "twfe_intensity",
      control_mode: "none", interaction: false, price_mode: "nominal", scenario: "clean",
      scenario_label: "基准", sample_filter: "排除ROW", exclude_row: true, controls: [], control_labels: {},
      equation: "y=x", equation_parts: [], panel_file: "panel_teaching.csv", entity: "entity_id", cluster: "country",
    },
    result: {
      depvar: "y", coefs: [coef], n_obs: 10, n_entities: 2, n_times: 5, n_clusters: 2,
      r2_within: 0.1, depvar_mean: 2, depvar_std: 2, diagnostics: {}, notes: [],
      status: support?.status ?? "ok", status_reasons: support?.reasons ?? [], support,
    },
    benchmark: {
      backend: "PanelOLS", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0,
      coef_check_passed: true, se_check_mode: "informational", notes: [],
    },
    disclaimer: "mock",
  };
}

const blockedSupport = (status: "insufficient" | "invalid_design"): TreatmentSupport => ({
  treated_clusters: 1, untreated_clusters: 2, treated_entities: 2, reversal_entities: [],
  reversal_share: 0, absorbing: false, status, reasons: ["处理支持度不足"],
  min_treated_clusters: 5, max_reversal_share: 0.05, suppress_inference: true,
});

describe("fixed TWFE verdict", () => {
  test("uses confidence intervals rather than coefficient sign", () => {
    const verdict = buildRegressionVerdict("trade", response("trade", coefficient(-0.01, -0.03, 0.01)));
    expect(verdict.state).toBe("insufficient");
    expect(verdict.evidence).toContain("不等于“没有效应”");
  });

  test("scales the fixed intensity coefficient to a one-point increase", () => {
    expect(buildRegressionVerdict("trade", response("trade", coefficient(0.4, 0.2, 0.6))).effect)
      .toBe("+0.40 个百分点");
    expect(buildRegressionVerdict("length", response("length", coefficient(2, 1, 3))).effect)
      .toContain("+0.020 个长度单位");
    expect(chartDisplayScale("network")).toEqual({ scale: 0.01, unit: "中心性原始单位" });
  });

  test("never turns suppressed inference into a zero-crossing claim", () => {
    const verdict = buildRegressionVerdict(
      "trade", response("trade", coefficient(-0.0084, null, null), blockedSupport("insufficient")),
    );
    expect(verdict.state).toBe("suppressed");
    expect(verdict.interval).toBe("—");
    expect(verdict.evidence).not.toContain("跨过 0");
  });

  test("labels invalid designs separately", () => {
    const verdict = buildRegressionVerdict(
      "trade", response("trade", coefficient(-0.005, null, null), blockedSupport("invalid_design")),
    );
    expect(verdict.title).toContain("不能用于统计推断");
  });
});

test("every regression status has safe display copy", () => {
  expect(Object.keys(REGRESSION_STATUS_LABELS).sort()).toEqual(
    ["insufficient", "invalid_design", "ok", "warning"],
  );
  expect(regressionStatusLabel("bogus")).toBe("设计有效性未知");
});
