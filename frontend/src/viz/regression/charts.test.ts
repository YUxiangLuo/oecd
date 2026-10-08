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
    expect(markup).toContain("只显示估计值，不显示 95% 区间");
    expect(markup).toContain("<circle");
    expect(markup).not.toContain('class="coef-ci"');
    expect(markup).not.toContain("91.234");
    expect(markup).not.toContain("***");
  });

  test("valid inference retains its confidence interval", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{ name: "x", coef: -0.2, ci_low: -0.3, ci_high: -0.1, p: 0.001, stars: "***" }],
      globalStatus: "ok",
    }));
    expect(markup).toContain("横线 = 95% 区间");
    expect(markup).toContain('class="coef-ci"');
    expect(markup).toContain('<circle cx="265.5" cy="48" r="6.5" fill="#2a2f3a"');
    // Significance stars are not shown; the interval already tells the direction.
    expect(markup).not.toContain("***");
  });
});
