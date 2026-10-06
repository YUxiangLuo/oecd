import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegressionCoefficientTable, RegressionResultCard, TEACHING_MODEL_VERSION } from "./regression";
import type { RegressionResponse } from "./types";
import { CoefForestChart } from "./viz/regression/charts";

afterEach(cleanup);

function response(): RegressionResponse {
  return {
    design: { outcome: "trade", depvar: "y", depvar_label: "Y", granularity: "country_industry", shock_type: "tariff", shock_col: "teaching_tariff_exposure", treated_col: "", method: "twfe_intensity", control_mode: "none", interaction: false, price_mode: "nominal", scenario: "clean", weight_mode: "fixed_pretreatment", scenario_label: "教学", sample_filter: "排除 ROW", exclude_row: true, controls: [], control_labels: {}, equation: "Y = beta X + entity FE + year FE", equation_parts: [], panel_file: "teaching.csv", entity: "entity_id", cluster: "country" },
    result: { depvar: "y", coefs: [{ name: "teaching_tariff_exposure", coef: 2, se: .5, t: 4, p: .001, stars: "***", ci_low: 1, ci_high: 3 }], n_obs: 100, n_entities: 20, n_times: 5, n_clusters: 10, r2_within: .2, depvar_mean: .3, depvar_std: .1, diagnostics: {}, notes: [], status: "ok", status_reasons: [], support: { treated_clusters: 10, untreated_clusters: 0, treated_entities: 20, untreated_entities: 0, total_entities: 20, reversal_entities: [], reversal_share: 0, absorbing: true, status: "ok", reasons: [], min_treated_clusters: 5, max_reversal_share: 0, suppress_inference: false } },
    benchmark: { backend: "test", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "test", notes: [] },
    model_snapshot: { version: TEACHING_MODEL_VERSION, x_columns: ["teaching_tariff_exposure"], y_column: "y", entity: "entity_id", time: "year", fixed_effects: ["entity", "year"], controls: [], interactions: [], seed: 1, beta: 2, tariff_path: [], disclaimer: "教学" },
    variable_catalog: [], disclaimer: "教学",
  };
}

describe("fixed teaching regression reading", () => {
  test("uses the snapshot X and reports a one-percentage-point X increment", () => {
    const html = renderToStaticMarkup(<RegressionResultCard outcome="trade" response={response()} />);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(html).toContain("回归结果");
    expect(html).toContain("方向判断：本次样本支持正向关联");
    expect(html).not.toContain("模拟");
    // One coefficient plot: zero line plus one dot (one colour, no bar) with its interval.
    expect(dom.querySelectorAll("svg[role=img]")).toHaveLength(1);
    expect(dom.querySelectorAll("svg rect")).toHaveLength(0);
    expect(dom.querySelector('svg circle[r="6.5"]')?.getAttribute("fill")).toBe("#2a2f3a");
    expect(dom.querySelector(".coef-ci")).not.toBeNull();
    // Three short sentences, no folds.
    expect(dom.querySelectorAll(".reg-result-points > li")).toHaveLength(3);
    expect(dom.querySelector("details")).toBeNull();
    expect(html).toContain("平均上升 2.00 个百分点");
    expect(html).toContain("[+1.00, +3.00] 个百分点");
    expect(html).toContain("标称 95% 的近似聚类区间");
    expect(html).toContain("不要写成「已经证明生产回流」");
    expect(html).not.toMatch(/处理组|对照组|处理聚类|同时置信带|与生成时的预设关系|使用的年度记录/);
  });

  test("draws the binned scatter in display units: shares in percentage points, slope per 1 pp of X", () => {
    const withBins = response();
    withBins.result.coefs[0].coef = -0.55;
    withBins.result.coefs[0].ci_low = -0.57;
    withBins.result.coefs[0].ci_high = -0.53;
    withBins.result.binscatter = {
      bins: [{ x: -0.02, y: 0.011, n: 10 }, { x: 0, y: 0, n: 10 }, { x: 0.02, y: -0.011, n: 10 }],
      slope: -0.55,
      transform: "twoway_demeaned",
    };
    const html = renderToStaticMarkup(<RegressionResultCard outcome="trade" response={withBins} />);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelectorAll("svg[role=img]")).toHaveLength(2);
    // β for a share outcome is already "percentage points of Y per percentage point of X".
    expect(html).toContain("斜率 β = -0.550");
    // Bin means are shown in percentage points (×100), so the Y axis spans about ±1.1, not ±0.011.
    const texts = [...dom.querySelectorAll("svg text")].map((node) => node.textContent ?? "");
    expect(texts.some((text) => /^-?1\.[0-9]+$/.test(text))).toBe(true);
    expect(texts.some((text) => text === "0.0100" || text === "-0.0100")).toBe(false);
    // A narrow interval is labelled once, in the middle, instead of two colliding end labels.
    expect(html).toContain("[-0.57, -0.53]");
  });

  test.each([
    [-0.8, -0.2, "本次样本支持负向关联", true],
    [-0.9, 0.1, "本次样本不足以判断方向", false],
    [-0.8, 0, "本次样本不足以判断方向", false],
  ])("negative point estimate with interval [%s, %s] is interpreted using the interval", (low, high, title, negative) => {
    const data = response();
    Object.assign(data.result.coefs[0], { coef: -0.4, ci_low: low, ci_high: high });
    const { container } = render(<RegressionResultCard outcome="production" response={data} />);
    expect(container.querySelector(".reg-plain-verdict")?.textContent).toBe(`方向判断：${title}`);
    expect(container.textContent?.includes("平均下降")).toBe(negative);
    expect(container.querySelector(".reg-result-points")?.textContent).toMatch(negative ? /平均下降 0.40 个百分点/ : /平均变化为 -0.40 个百分点/);
    // The estimate dot keeps one colour whatever its sign; the sign is read from its position.
    expect(container.querySelector('svg circle[r="6.5"]')?.getAttribute("fill")).toBe("#2a2f3a");
  });

  test("suppressed inference takes priority even over an apparently positive interval", () => {
    const data = response();
    data.result.status = "invalid_design";
    data.result.status_reasons = ["可用于比较的国家太少"];
    const { container } = render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByText(/方向判断：这个设计不能用于统计推断/)).toBeTruthy();
    expect(screen.getByText(/无法推断：可用于比较的国家太少/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/平均上升|平均下降|区间未跨过/);
    // The chart keeps only a grey descriptive dot: no colour, no interval.
    expect(container.querySelector('svg circle[r="6.5"]')?.getAttribute("fill")).toBe("#b6bac6");
    expect(container.querySelector(".coef-ci")).toBeNull();
    expect(container.textContent).toContain("仅显示描述性点估计");
    expect(container.textContent).not.toContain("[+1.00, +3.00]");
  });

  test("a missing coefficient never produces a numeric reading sentence", () => {
    const data = response();
    data.result.coefs = [];
    const { container } = render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByText(/当前设定没有可解读的政策系数/)).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).not.toContain("平均变化为 —");
  });

  test("converts the estimate to the two step-10 examples, including an untaxed one", () => {
    const data = response();
    Object.assign(data.result.coefs[0], { coef: -0.55, ci_low: -0.61, ci_high: -0.5 });
    const { container } = render(<RegressionResultCard outcome="trade" response={data} examples={[
      { label: "CAN 加拿大·C29", x: 0.0932 },
      { label: "MEX 墨西哥·C29", x: 0 },
    ]} />);
    const sentence = container.querySelector(".reg-example-effect")!.textContent;
    expect(sentence).toBe("换算到你在步骤 10 选的例子：CAN 加拿大·C29（X = 9.32 个百分点）Y 约下降 5.13 个百分点；MEX 墨西哥·C29未被加税（X = 0），按估计不变。");
    // An uncertain direction is flagged; suppressed inference and missing examples show no conversion.
    Object.assign(data.result.coefs[0], { ci_low: -1, ci_high: 0.2 });
    const uncertain = render(<RegressionResultCard outcome="trade" response={data} examples={[{ label: "例子", x: 0.05 }]} />);
    expect(uncertain.container.querySelector(".reg-example-effect")!.textContent).toContain("区间跨过 0，这个方向本身并不确定");
    data.result.status = "invalid_design";
    const suppressed = render(<RegressionResultCard outcome="trade" response={data} examples={[{ label: "例子", x: 0.05 }]} />);
    expect(suppressed.container.querySelector(".reg-example-effect")).toBeNull();
  });

  test("allowed estimates still disclose design warnings", () => {
    const data = response();
    data.result.status = "warning";
    data.result.support!.status = "warning";
    data.result.status_reasons = ["部分国家年度记录缺失"];
    render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByRole("list", { name: "本次计算的限制" }).textContent).toContain("部分国家年度记录缺失");
    expect(screen.getByText("平均上升 2.00 个百分点")).toBeTruthy();
  });
});

test.each(["unknown", "conflicting"])("%s status suppresses table and forest inference", (status) => {
  const data = response();
  if (status === "unknown") data.result.status = null;
  else data.result.support!.status = "warning";
  const table = render(<RegressionCoefficientTable response={data} />);
  const cells = table.container.querySelectorAll("tbody td");
  expect(cells[2].textContent).toBe("—");
  expect(cells[5].textContent).toBe("—");
  table.unmount();
  const plot = render(<CoefForestChart coefs={data.result.coefs} globalStatus={data.result.status} globalSupport={data.result.support} />);
  fireEvent.mouseEnter(plot.container.querySelector("circle")!.closest("g")!);
  expect(plot.container.textContent).toContain("仅显示描述性点估计");
  expect(plot.container.textContent).not.toContain("p 值 ·");
});

test.each([
  [2.7231068455073544e-24, "<0.0001"],
  [0, "<0.0001"],
  [0.00009999, "<0.0001"],
  [0.0001, "0.0001"],
  [0.0256, "0.0256"],
  [1, "1"],
  [null, "—"],
] as const)("p=%s is legible in both the raw table and forest tooltip", (p, expected) => {
  const data = response();
  data.result.coefs[0].p = p;
  const table = render(<RegressionCoefficientTable response={data} />);
  expect(table.container.querySelector("tbody td:last-child")?.textContent).toBe(expected);
  table.unmount();
  const plot = render(<CoefForestChart coefs={data.result.coefs} globalStatus={data.result.status} globalSupport={data.result.support} />);
  fireEvent.mouseEnter(plot.container.querySelector("circle")!.closest("g")!);
  expect(plot.container.textContent).toContain(`p 值 · ${p == null ? "不可评估" : expected}`);
});

