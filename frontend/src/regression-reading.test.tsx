import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RegressionResultCard } from "./regression";
import type { RegressionResponse } from "./types";

function response(): RegressionResponse {
  return {
    design: { outcome: "trade", depvar: "y", depvar_label: "Y", granularity: "country_industry", shock_type: "tariff", shock_col: "teaching_tariff_exposure", treated_col: "", method: "twfe_intensity", control_mode: "none", interaction: false, price_mode: "nominal", scenario: "clean", weight_mode: "fixed_pretreatment", scenario_label: "教学", sample_filter: "排除 ROW", exclude_row: true, controls: [], control_labels: {}, equation: "Y = beta X + entity FE + year FE", equation_parts: [], panel_file: "teaching.csv", entity: "entity_id", cluster: "country" },
    result: { depvar: "y", coefs: [{ name: "teaching_tariff_exposure", coef: 2, se: .5, t: 4, p: .001, stars: "***", ci_low: 1, ci_high: 3 }], n_obs: 100, n_entities: 20, n_times: 5, n_clusters: 10, r2_within: .2, depvar_mean: .3, depvar_std: .1, diagnostics: {}, notes: [], status: "ok", status_reasons: [], support: { treated_clusters: 10, untreated_clusters: 0, treated_entities: 20, untreated_entities: 0, total_entities: 20, reversal_entities: [], reversal_share: 0, absorbing: true, status: "ok", reasons: [], min_treated_clusters: 5, max_reversal_share: 0, suppress_inference: false } },
    benchmark: { backend: "test", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "test", notes: [] },
    model_snapshot: { version: "step10-tariff-teaching-v1", x_columns: ["teaching_tariff_exposure"], y_column: "y", entity: "entity_id", time: "year", fixed_effects: ["entity", "year"], controls: [], interactions: [], seed: 1, beta: 2, tariff_path: [], disclaimer: "教学" },
    variable_catalog: [], disclaimer: "教学",
  };
}

describe("fixed teaching regression reading", () => {
  test("uses the snapshot X and reports a one-percentage-point X increment", () => {
    const html = renderToStaticMarkup(<RegressionResultCard outcome="trade" response={response()} />);
    expect(html).toContain("两者在模拟数据中怎样一起变化");
    expect(html).toContain("想观察的结果（Y）");
    expect(html).toContain("教学模拟：外国增加值项占比");
    expect(html).toContain("使用的年度记录");
    expect(html).toContain("平均上升 2.00 个百分点");
    expect(html).toContain("X 与 Y 都由课程生成");
    expect(html).not.toMatch(/处理组|对照组|处理聚类|同时置信带/);
    expect(html).toContain("+2.00 个百分点");
    expect(html).toContain("[+1.00, +3.00] 个百分点");
  });
});
