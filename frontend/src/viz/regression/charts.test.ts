import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TreatmentSupport } from "../../types";
import { CoefForestChart, scaleForestCoefs } from "./charts";

describe("fixed regression forest chart", () => {
  test("scales coefficients without mutating a scale-one input", () => {
    const coefs = [{ name: "x", coef: 0.2, ci_low: 0.1, ci_high: 0.3 }];
    expect(scaleForestCoefs(coefs, 1)).toBe(coefs);
    expect(scaleForestCoefs(coefs, 0.01)[0]).toEqual({
      name: "x", coef: 0.002, ci_low: 0.001, ci_high: 0.003,
    });
  });

  test("suppressed inference shows only the point estimate", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{ name: "x", coef: -0.2, ci_low: -91.234, ci_high: 87.654, p: 0.001, stars: "***" }],
      globalStatus: "insufficient",
      globalSupport: { status: "insufficient", suppress_inference: true } as TreatmentSupport,
    }));
    expect(markup).toContain("整体设计门禁已抑制统计推断");
    expect(markup).toContain("<circle");
    expect(markup).not.toContain('stroke="#aaa7eb"');
    expect(markup).not.toContain("91.234");
    expect(markup).not.toContain("***");
  });

  test("valid inference retains its confidence interval", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{ name: "x", coef: -0.2, ci_low: -0.3, ci_high: -0.1, p: 0.001, stars: "***" }],
      globalStatus: "ok",
    }));
    expect(markup).toContain("点 = 估计值 · 横线 = 95% 置信区间");
    expect(markup).toContain('stroke="#aaa7eb"');
  });
});
