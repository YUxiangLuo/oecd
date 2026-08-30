import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DidFourCells,
  FamilyMap,
  RegressionEvidenceMatrix,
  RegressionReadingCheck,
  familyVerdict,
  readingAnswerForDirection,
} from "./regression-teach";
import type { CoefStat, RegressionOutcome, RegressionResponse } from "./types";

const coefficient = (coef: number, low: number, high: number): CoefStat => ({
  name: "treated×post", coef, se: 0.01, t: 1, p: 0.2, stars: "", ci_low: low, ci_high: high,
});

function response(outcome: RegressionOutcome, coef: CoefStat): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "Y", granularity: "country", shock_type: "tariff",
      shock_col: "tariff_shock", treated_col: "treated", method: "did", control_mode: "none",
      interaction: false, price_mode: "nominal", scenario: "clean", scenario_label: "基准", sample_filter: "排除ROW",
      exclude_row: true, controls: [], control_labels: {}, equation: "y=x", equation_parts: [], panel_file: "panel.csv",
      entity: "country", cluster: "country",
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

describe("DidFourCells", () => {
  test("names the corner column header in both visual variants", () => {
    for (const numeric of [false, true]) {
      const html = renderToStaticMarkup(createElement(DidFourCells, { numeric }));
      expect(html).toContain('<th scope="col"><span class="sr-only">组别</span></th>');
      expect(html).not.toContain('<th scope="col"></th>');
    }
  });
});

describe("familyVerdict", () => {
  test("prefers in-memory history over a saved sibling run", () => {
    const live = response("trade", coefficient(-0.02, -0.03, -0.01));
    const saved = response("trade", coefficient(0.02, 0.01, 0.03));
    const verdict = familyVerdict(
      "trade",
      { trade: [{ response: live }] },
      (step) => step === 12 ? { run: { design: saved.design, result: saved.result } } : undefined,
    );
    expect(verdict?.state).toBe("negative");
  });

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
      name: "treated×post", coef: -0.02, se: 0.01, t: 1, p: null, stars: "", ci_low: null, ci_high: null,
    }];
    const verdict = familyVerdict(
      "trade",
      { trade: [{ response: latest }] },
      (step) => step === 12 ? { run: { design: latest.design, result: latest.result }, qualified_run: { design: qualified.design, result: qualified.result } } : undefined,
    );
    expect(verdict?.state).toBe("negative");
  });

  test("falls back to the qualified sibling run after refresh", () => {
    const saved = response("production", coefficient(0.01, -0.02, 0.04));
    const verdict = familyVerdict(
      "production",
      {},
      (step) => step === 13 ? { qualified_run: { design: saved.design, result: saved.result } } : undefined,
    );
    expect(verdict?.state).toBe("insufficient");
  });
});

describe("student-first regression reading", () => {
  test("maps diagnostic failures to a blocked judgment and uncertainty to look-inconclusive", () => {
    expect(readingAnswerForDirection("positive")).toBe("positive");
    expect(readingAnswerForDirection("negative")).toBe("negative");
    expect(readingAnswerForDirection("insufficient")).toBe("insufficient");
    expect(readingAnswerForDirection("pretrend")).toBe("blocked");
    expect(readingAnswerForDirection("suppressed")).toBe("blocked");
  });

  test("gives retry feedback without changing the four-option formative exercise", () => {
    const wrong = renderToStaticMarkup(createElement(RegressionReadingCheck, {
      answer: "positive",
      expected: "insufficient",
      onAnswer: () => {},
    }));
    expect(wrong.match(/aria-pressed=/g)).toHaveLength(4);
    expect(wrong).toContain("再试一次");
    expect(wrong).toContain("不影响完成状态");

    const correct = renderToStaticMarkup(createElement(RegressionReadingCheck, {
      answer: "insufficient",
      expected: "insufficient",
      onAnswer: () => {},
    }));
    expect(correct).toContain("判断正确");
  });

  test("puts all four saved families into one report-ready evidence matrix", () => {
    const trade = response("trade", coefficient(-0.02, -0.03, -0.01));
    const html = renderToStaticMarkup(createElement(RegressionEvidenceMatrix, {
      getStep: (step: number) => step === 12
        ? { qualified_run: { design: trade.design, result: trade.result } }
        : undefined,
    }));
    expect(html).toContain("四步证据总表");
    expect(html.match(/<th scope="row">/g)).toHaveLength(4);
    expect(html).toContain("下降");
    expect(html).toContain("待估计");
    expect(html).toContain("不同指标的系数不能比大小");
  });

  test("keeps the current family direction hidden until the student has judged it", () => {
    const trade = response("trade", coefficient(-0.02, -0.03, -0.01));
    const hidden = renderToStaticMarkup(createElement(FamilyMap, {
      current: "trade",
      history: { trade: [{ response: trade }] },
      revealCurrent: false,
    }));
    expect(hidden).toContain("当前 · 已估计，待判断");
    expect(hidden).not.toContain("当前 · 下降");

    const revealed = renderToStaticMarkup(createElement(FamilyMap, {
      current: "trade",
      history: { trade: [{ response: trade }] },
      revealCurrent: true,
      currentDirection: "suppressed",
    }));
    expect(revealed).toContain("当前 · 无法评估");
    expect(revealed).not.toContain("当前 · 下降");
  });
});
