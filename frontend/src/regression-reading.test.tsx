import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegressionCoefficientTable, RegressionResultCard, TEACHING_MODEL_VERSION } from "./regression";
import { BASELINE_LESSONS, REGRESSION_LESSONS } from "./regression-lessons";
import type { RegressionResponse } from "./types";

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
    // The headline answers the question with the number; a badge and the interval in words follow.
    // An association across country×industry records ("X 每高 1 个百分点的国家×行业"), no arrow and no "上升".
    expect(dom.querySelector(".reg-plain-verdict")?.textContent).toBe("关税暴露 X 每高 1 个百分点的国家×行业，外国增加值项占比平均高 2.00 个百分点");
    expect(dom.querySelector(".reg-plain-verdict")?.textContent).not.toMatch(/→|X 每增加|上升/);
    expect(dom.querySelector(".reg-direction-badge")?.textContent).toBe("方向明确");
    expect(dom.querySelector(".reg-interval-words")?.textContent).toBe("95% 区间（真实系数的合理取值范围）为 [+1.00, +3.00] 个百分点，整个区间都在 0 的一侧，所以方向是明确的。");
    expect(html).not.toContain("模拟");
    // The charts are above the card (bars, trend), not in it: no plot, no 本步重点, no reading cards.
    expect(dom.querySelectorAll("svg")).toHaveLength(0);
    // Without an example: two one-liners, what not to claim and the generated-data note.
    const points = [...dom.querySelectorAll(".reg-result-points > li")].map((item) => item.textContent);
    expect(points).toEqual([
      "解释限制 不要写成“已经证明生产回流”。这一项占比较高或较低，不能说明企业是否把生产搬回国内。",
      "关税情景与步骤 11–14 的四个 Y 由课程按设定生成（参照真实指标的量级），用于练习读回归，不是真实关税或 OECD 发布的结果。",
    ]);
    expect(html).not.toContain("估计值可能落在");
    expect(dom.querySelector("details")).toBeNull();
    expect(html).not.toMatch(/β|本次样本|置信区间|标称/);
    expect(html).not.toMatch(/处理组|对照组|处理聚类|同时置信带|与生成时的预设关系|使用的年度记录/);
  });

  test("step 14 says its unit is not the 百万美元 of steps 5 and 9; other steps do not", () => {
    const network = response();
    network.design.depvar_kind = "network";
    Object.assign(network.result.coefs[0], { coef: -4080, ci_low: -4180, ci_high: -3980 });
    network.result.depvar_std = 850;
    const dom = new DOMParser().parseFromString(renderToStaticMarkup(<RegressionResultCard outcome="network" response={network} />), "text/html");
    expect(dom.querySelector(".reg-unit-note")?.textContent).toBe("中心性原始单位：本步的 Y 是课程按真实网络指标的排名校准生成的数值，不是步骤 5、9 的百万美元，不能和那两步的数值直接比较。");
    expect(renderToStaticMarkup(<RegressionResultCard outcome="trade" response={response()} />)).not.toContain("reg-unit-note");
  });

  test("limitation lines are associations: 较高／较低, not 上升／下降 or 变化", () => {
    for (const lesson of [...Object.values(REGRESSION_LESSONS), ...Object.values(BASELINE_LESSONS)]) {
      // Quoted phrases are the claims not to make; the explanation around them compares levels.
      expect(lesson.dontClaim.replace(/“[^”]*”/g, "")).not.toMatch(/上升|下降|变化/);
    }
  });

  test.each([
    [-0.8, -0.2, "方向明确", true],
    [-0.9, 0.1, "方向不确定", false],
    [-0.8, 0, "方向不确定", false],
  ])("negative point estimate with interval [%s, %s] is interpreted using the interval", (low, high, title, negative) => {
    const data = response();
    Object.assign(data.result.coefs[0], { coef: -0.4, ci_low: low, ci_high: high });
    const { container } = render(<RegressionResultCard outcome="production" response={data} />);
    expect(container.querySelector(".reg-direction-badge")?.textContent).toBe(title);
    expect(container.textContent?.includes("平均低")).toBe(negative);
    // An interval that includes 0 gives the signed estimate without 高/低 and says the direction is open.
    expect(container.querySelector(".reg-plain-verdict")?.textContent).toMatch(negative ? /平均低 0.40 个百分点/ : /平均相差 -0.40 个百分点，但高低方向不确定/);
  });

  test("suppressed inference takes priority even over an apparently positive interval", () => {
    const data = response();
    data.result.status = "invalid_design";
    data.result.status_reasons = ["可用于比较的国家太少"];
    const { container } = render(<RegressionResultCard outcome="trade" response={data} />);
    expect(container.querySelector(".reg-direction-badge")?.textContent).toBe("方向不确定");
    expect(screen.getByText(/原因：可用于比较的国家太少/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/平均上升|平均下降|区间未跨过/);
    expect(container.textContent).toContain("只显示估计值、不显示 95% 区间");
    expect(container.textContent).not.toContain("[+1.00, +3.00]");
  });

  test("a missing coefficient never produces a numeric reading sentence", () => {
    const data = response();
    data.result.coefs = [];
    const { container } = render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByRole("heading", { name: "没算出 X 的估计值" })).toBeTruthy();
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
    // An association with X, not a tariff effect; X = 0 implies no X-related difference (not "Y 不变").
    expect(sentence).toBe("按你在步骤 10 选的例子换算：CAN 加拿大·C29 的 X 为 9.32 个百分点，按估计与 X 相关的差异约为 -5.13 个百分点（Y 偏低）；MEX 墨西哥·C29 未被加税，X = 0，按估计没有与 X 相关的差异。");
    expect(sentence).not.toMatch(/下降|不变|X 为 0 时/);
    // An uncertain direction is flagged; suppressed inference and missing examples show no conversion.
    Object.assign(data.result.coefs[0], { ci_low: -1, ci_high: 0.2 });
    const uncertain = render(<RegressionResultCard outcome="trade" response={data} examples={[{ label: "例子", x: 0.05 }]} />);
    const uncertainText = uncertain.container.querySelector(".reg-example-effect")!.textContent;
    expect(uncertainText).toContain("按估计与 X 相关的差异约为 -2.75 个百分点，但区间包含 0，差异的高低方向并不确定。");
    expect(uncertainText).not.toContain("偏低");
    data.result.status = "invalid_design";
    const suppressed = render(<RegressionResultCard outcome="trade" response={data} examples={[{ label: "例子", x: 0.05 }]} />);
    expect(suppressed.container.querySelector(".reg-example-effect")).toBeNull();
  });

  test("an interval that includes 0 reads gracefully: headline, direction, conversion and slope keep the sign open", () => {
    // A weak Y (generated with no relation to X): the estimate is small and its interval spans 0.
    const data = response();
    data.design.outcome = "production";
    data.design.baseline = "3b_FGY_GVC_C_share";
    data.design.baseline_label = "后向复杂 GVC 生产份额";
    data.design.depvar_kind = "share";
    Object.assign(data.result.coefs[0], { coef: 0.12, ci_low: -0.3, ci_high: 0.54, p: 0.6 });
    const { container } = render(<RegressionResultCard outcome="production" response={data} examples={[
      { label: "CAN 加拿大·C29", x: 0.2325 },
      { label: "USA 美国·C29", x: 0, imposer: true },
    ]} />);
    expect(container.querySelector(".reg-headline-main")?.textContent).toBe(
      "关税暴露 X 每高 1 个百分点的国家×行业，后向复杂 GVC 生产份额平均相差 +0.12 个百分点，但高低方向不确定",
    );
    expect(container.querySelector(".reg-direction-badge")?.textContent).toBe("方向不确定");
    expect(container.querySelector(".reg-interval-words")?.textContent).toBe(
      "95% 区间（真实系数的合理取值范围）为 [-0.30, +0.54] 个百分点，包含 0：不能说“没有关联”，只能说方向还不确定。",
    );
    expect(container.querySelector(".reg-example-effect")?.textContent).toBe(
      "按你在步骤 10 选的例子换算：CAN 加拿大·C29 的 X 为 23.25 个百分点，按估计与 X 相关的差异约为 +2.79 个百分点，但区间包含 0，差异的高低方向并不确定；"
      + "USA 美国·C29 属于加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义，不做换算。",
    );
    expect(container.textContent).not.toMatch(/平均高|平均低|偏高|偏低|没受加税影响/);
  });

  test("examples with X = 0 say so once, without the interval's uncertainty, for untaxed and w = 0 pairs alike", () => {
    const data = response();
    Object.assign(data.result.coefs[0], { coef: 0.12, ci_low: -0.3, ci_high: 0.54, p: 0.6 });
    const sentence = (examples: { label: string; x: number; tau?: number }[]) => {
      const { container, unmount } = render(<RegressionResultCard outcome="production" response={data} examples={examples} />);
      const text = container.querySelector(".reg-example-effect")!.textContent!;
      unmount();
      return text;
    };
    const untaxed = sentence([{ label: "GBR 英国·C29", x: 0, tau: 0 }, { label: "FRA 法国·C29", x: 0, tau: 0 }]);
    expect(untaxed).toBe("按你在步骤 10 选的例子换算：GBR 英国·C29 未被加税；FRA 法国·C29 未被加税。"
      + "两个例子的 X 都是 0，换算不出与 X 相关的差异。想看换算，回步骤 10 选一个被加税的国家（如加拿大）。");
    const unexposed = sentence([{ label: "BRN 文莱·C22", x: 0, tau: 0.25 }, { label: "MEX 墨西哥·C22", x: 0, tau: 0 }]);
    expect(unexposed).toContain("BRN 文莱·C22 被加税但首年不向美国出口（w = 0）；MEX 墨西哥·C22 未被加税。两个例子的 X 都是 0");
    expect(unexposed).toContain("换一个向美国出口的被加税国家或行业");
    const single = sentence([{ label: "GBR 英国·C29", x: 0, tau: 0 }]);
    expect(single).toBe("按你在步骤 10 选的例子换算：GBR 英国·C29 未被加税。"
      + "这个例子的 X = 0，换算不出与 X 相关的差异。想看换算，回步骤 10 换成被加税的国家（如加拿大），或再选一个被加税的对比国家。");
    for (const text of [untaxed, unexposed, single]) {
      expect(text).not.toContain("区间包含 0");
      expect(text).not.toContain("按估计没有与 X 相关的差异");
      expect(text.match(/X = 0|X 都是 0/g)).toHaveLength(1);
    }
  });

  test("a length reading gives its size in standard deviations, unsigned, as step 14 and the report do", () => {
    const data = response();
    data.design.outcome = "length";
    data.design.depvar_kind = "length";
    Object.assign(data.result.coefs[0], { coef: -1.8186, ci_low: -1.9, ci_high: -1.7 });
    data.result.depvar_mean = 3.95;
    data.result.depvar_std = 0.58;
    const { container } = render(<RegressionResultCard outcome="length" response={data} />);
    expect(container.querySelector(".reg-headline-main")?.textContent)
      .toContain("前向 GVC 段长度平均短 0.018 个长度单位（幅度约 0.031 个标准差，标准差即 Y 的典型差距）");
    expect(container.querySelector(".reg-interval-words")?.textContent).toContain("[-0.019, -0.017] 个长度单位；约 [-0.033, -0.029] 个标准差");
    expect(container.textContent).not.toContain("样本均值");
    // The definition is said once on the card.
    expect(container.textContent?.match(/标准差即 Y 的典型差距/g)).toHaveLength(1);
  });

  test("the position index reads in standard deviations too", () => {
    const data = response();
    data.design.outcome = "length";
    data.design.depvar_kind = "position";
    data.design.baseline = "GVCPs";
    Object.assign(data.result.coefs[0], { coef: -0.21, ci_low: -0.30, ci_high: -0.12 });
    data.result.depvar_std = 0.17;
    const { container } = render(<RegressionResultCard outcome="length" response={data} />);
    expect(container.querySelector(".reg-headline-main")?.textContent)
      .toContain("平均低 0.0021 个位置指数单位（幅度约 0.012 个标准差，标准差即 Y 的典型差距）");
  });

  test("allowed estimates still disclose design warnings", () => {
    const data = response();
    data.result.status = "warning";
    data.result.support!.status = "warning";
    data.result.status_reasons = ["部分国家年度记录缺失"];
    render(<RegressionResultCard outcome="trade" response={data} />);
    expect(screen.getByRole("list", { name: "本次计算的限制" }).textContent).toContain("部分国家年度记录缺失");
    expect(screen.getByText("平均高 2.00 个百分点")).toBeTruthy();
  });

  test("the coefficient table states its scale next to the page's per-percentage-point reading", () => {
    // A length outcome: the raw coefficient (X as a share) is 100 times the reading per percentage point.
    const data = response();
    data.design.outcome = "length";
    data.design.depvar_kind = "length";
    Object.assign(data.result.coefs[0], { coef: -1.8186, ci_low: -1.9, ci_high: -1.7 });
    const table = render(<RegressionCoefficientTable response={data} />);
    const headers = [...table.container.querySelectorAll("th")].map((cell) => cell.textContent);
    expect(headers.slice(0, 3)).toEqual(["变量", "X 每高 1 个百分点，Y 平均相差（长度单位）", "系数（X 按份额计）"]);
    const cells = [...table.container.querySelectorAll("tbody td")].map((cell) => cell.textContent);
    expect(cells[1]).toBe("-0.018 个长度单位");
    expect(cells[2]).toBe("-1.8186");
  });
});

test.each(["unknown", "conflicting"])("%s status suppresses table inference", (status) => {
  const data = response();
  if (status === "unknown") data.result.status = null;
  else data.result.support!.status = "warning";
  const table = render(<RegressionCoefficientTable response={data} />);
  const cells = table.container.querySelectorAll("tbody td");
  expect(cells[3].textContent).toBe("—");
  expect(cells[6].textContent).toBe("—");
});

test.each([
  [2.7231068455073544e-24, "<0.0001"],
  [0, "<0.0001"],
  [0.00009999, "<0.0001"],
  [0.0001, "0.0001"],
  [0.0256, "0.0256"],
  [1, "1"],
  [null, "—"],
] as const)("p=%s is legible in the raw table", (p, expected) => {
  const data = response();
  data.result.coefs[0].p = p;
  const table = render(<RegressionCoefficientTable response={data} />);
  expect(table.container.querySelector("tbody td:last-child")?.textContent).toBe(expected);
});

