import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegressionResultCard } from "./regression";
import { IntervalReadingExercise } from "./regression-teach";
import type { RegressionResponse } from "./types";

afterEach(cleanup);

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
    expect(html).toContain("方向判断：本次模拟样本支持正向关联");
    expect(html).toContain("不是各个国家结果的分布范围");
    expect(html).toContain("不能推出什么");
    expect(html).toContain("不要写成「已经证明生产回流」");
    expect(html).not.toContain("合理范围");
  });

  test.each([
    [-0.8, -0.2, "本次模拟样本支持负向关联", true],
    [-0.9, 0.1, "本次模拟样本不足以判断方向", false],
    [-0.8, 0, "本次模拟样本不足以判断方向", false],
  ])("negative point estimate with interval [%s, %s] is interpreted using the interval", (low, high, title, negative) => {
    const data = response();
    Object.assign(data.result.coefs[0], { coef: -0.4, ci_low: low, ci_high: high });
    const { container } = render(<RegressionResultCard outcome="production" response={data} />);
    expect(container.querySelector(".reg-plain-verdict")?.textContent).toBe(`方向判断：${title}`);
    expect(container.textContent?.includes("平均下降")).toBe(negative);
    expect(container.querySelector(".verdict-metrics")?.textContent).toContain("-0.40 个百分点");
  });

  test("suppressed inference takes priority even over an apparently positive interval", () => {
    const data = response();
    data.result.status = "invalid_design";
    data.result.status_reasons = ["可用于比较的国家太少"];
    const { container } = render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByText(/方向判断：这个设计不能用于统计推断/)).toBeTruthy();
    expect(screen.getByText(/停止推断原因：可用于比较的国家太少/)).toBeTruthy();
    expect(container.querySelector(".reg-simulation-comparison")).toBeNull();
    expect(container.querySelector(".verdict-metrics")).toBeNull();
    expect(container.textContent).not.toMatch(/平均上升|平均下降|区间未跨过/);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("+2.00 个百分点");
    expect(container.textContent).not.toContain("[+1.00, +3.00]");
  });

  test("a missing coefficient never produces a numeric reading sentence", () => {
    const data = response();
    data.result.coefs = [];
    const { container } = render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByText(/当前设定没有可解读的政策系数/)).toBeTruthy();
    expect(container.querySelector(".reg-simulation-comparison")).toBeNull();
    expect(container.querySelector(".verdict-metrics")).toBeNull();
    expect(container.textContent).not.toContain("平均变化为 —");
  });

  test("distinguishes generated entities from subsequent regression row filtering", () => {
    const data = response();
    data.result.sample_flow = { input_rows: 205, estimation_rows: 200, dropped_rows_total: 5 } as NonNullable<RegressionResponse["result"]["sample_flow"]>;
    const { container, rerender } = render(<RegressionResultCard outcome="trade" response={data} sourceFilter={{ source_baseline_rows: 45, published_entities: 41, excluded_source_baseline_rows: 4 }} />);
    const source = container.querySelector(".reg-source-filter")!.textContent;
    expect(source).toContain("45 个候选单元");
    expect(source).toContain("剔除 4 个");
    expect(source).toContain("保留 41 个");
    expect(container.textContent).toContain("输入 205 行模拟年度记录，另剔除 5 行");
    expect(source).toContain("四项回归共同使用");
    rerender(<RegressionResultCard outcome="trade" response={data} />);
    expect(container.querySelector(".reg-source-filter")).toBeNull();
  });

  test.each([
    ["trade", -0.55, -0.57, "-0.55 个百分点", "-0.02 个百分点"],
    ["production", -0.4, -0.28, "-0.40 个百分点", "+0.12 个百分点"],
    ["length", -1.8, -1.7, "-0.018 个长度单位", "+0.001 个长度单位"],
    ["network", -6000, -5977, "-60.00 个中心性原始单位", "+0.23 个中心性原始单位"],
  ] as const)("compares %s truth and estimate in the same display units", (outcome, beta, estimate, preset, difference) => {
    const data = response();
    data.model_snapshot!.beta = beta;
    data.result.coefs[0].coef = estimate;
    const { container, rerender } = render(<RegressionResultCard outcome={outcome} response={data} />);
    const comparison = container.querySelector(".reg-simulation-comparison")!.textContent;
    expect(comparison).toContain(`预设：${preset}`);
    expect(comparison).toContain(`差值（估计 − 预设）：${difference}`);
    delete data.model_snapshot;
    rerender(<RegressionResultCard outcome={outcome} response={data} />);
    expect(container.querySelector(".reg-simulation-comparison")).toBeNull();
  });

  test("allowed estimates still disclose design warnings", () => {
    const data = response();
    data.result.status = "warning";
    data.result.status_reasons = ["部分国家年度记录缺失"];
    render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByRole("list", { name: "本次计算的限制" }).textContent).toContain("部分国家年度记录缺失");
    expect(screen.getByText("平均上升 2.00 个百分点")).toBeTruthy();
  });
});

test("optional interval exercise corrects both misconceptions without creating a required task", () => {
  const { container } = render(<IntervalReadingExercise />);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("可选小练习：都是负数，结论一样吗？"));
  expect(screen.getByText(/不计分、不影响完成进度，也不进入报告/)).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByLabelText("两组都支持，因为点估计都是负数"));
  expect(screen.getByRole("status").textContent).toContain("不能只看点估计的正负");
  fireEvent.click(screen.getByLabelText("A 支持下降，B 证明没有变化"));
  expect(screen.getByRole("status").textContent).toContain("不能把证据不足当作没有变化");
  fireEvent.click(screen.getByLabelText("只有 A 支持，B 暂不能确定方向"));
  expect(screen.getByRole("status").textContent).toContain("答对了");
  expect(container.querySelectorAll("input:checked")).toHaveLength(1);
  expect(container.querySelectorAll("input[required], button[type=submit]")).toHaveLength(0);
});
