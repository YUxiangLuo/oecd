import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TreatmentSupport } from "../../types";
import { CoefForestChart, GroupChangeChart, scaleForestCoefs, spreadLabels } from "./charts";

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
    expect(markup).toContain('<circle cx="265.5" cy="62" r="6.5" fill="#2a2f3a"');
    // Significance stars are not shown; the interval already tells the direction.
    expect(markup).not.toContain("***");
  });

  test("a weak share estimate is labelled as in the headline (3 decimals), and 0 = 不变 sits above the rows", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{ name: "x", coef: 0.00752, ci_low: -0.0112, ci_high: 0.0262, p: 0.43, stars: "" }],
      globalStatus: "ok",
    }));
    expect(markup).toContain(">0.008<");
    expect(markup).toContain(">-0.011<");
    expect(markup).not.toContain("0.0075");
    const zero = /<text x="[\d.]+" y="([\d.]+)"[^>]*>0 = 不变/.exec(markup);
    expect(Number(zero?.[1])).toBeLessThan(62 - 21 - 10);
  });
});

describe("two-group chart labels", () => {
  test("spreadLabels keeps order and pushes close labels apart inside the bounds", () => {
    const slots = spreadLabels([
      { key: "a", at: 100, size: 14 }, { key: "b", at: 101, size: 14 }, { key: "e", at: 100.5, size: 28 },
    ], 20, 216);
    expect(slots.a).toBeLessThan(slots.e);
    expect(slots.e).toBeLessThan(slots.b);
    expect(slots.e - slots.a).toBeGreaterThanOrEqual(23);
    expect(slots.b - slots.e).toBeGreaterThanOrEqual(23);
    const low = spreadLabels([{ key: "a", at: 215, size: 14 }, { key: "b", at: 216, size: 14 }], 20, 216);
    expect(low.b).toBeLessThanOrEqual(209);
    expect(low.b - low.a).toBeGreaterThanOrEqual(16);
  });

  test("lines that end together keep the group names and the estimate readable", () => {
    const years = [2016, 2017, 2018, 2019, 2020];
    const series = (end: number) => years.map((year, index) => ({ year, change: index < 2 ? 0 : end }));
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, policyYear: 2018, taxed: series(0.0042), untaxed: series(0.0042), scale: 100, unit: "个百分点", title: "t",
      estimate: { gap: 0.0002, label: "回归估计的差距 +0.02 个百分点" },
    }));
    const at = (text: string) => Number(new RegExp(`y="([\\d.]+)"[^>]*>(?:<tspan[^>]*>)?${text}`).exec(markup)?.[1]);
    const taxed = at("加税国家组"), untaxed = at("未加税国家组");
    expect(Math.abs(taxed - untaxed)).toBeGreaterThanOrEqual(16);
  });
});
