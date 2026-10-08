import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TreatmentSupport } from "../../types";
import { BinScatterChart, CoefForestChart, GroupChangeChart, scaleForestCoefs, spreadLabels, svgTextWidth } from "./charts";

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
    expect(markup).toContain(">+0.008<");
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

describe("labels follow the headline and stay off the lines", () => {
  const bins = (xs: number[], slope: number) => xs.map((x) => ({ x, y: x * slope, n: 10 }));
  const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
  const slopeLabel = (markup: string) => parse(markup).querySelector("[data-slope-label]")!;

  test("the weak-Y interval ends and the open-direction slope carry their sign", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{ name: "x", coef: 0.00752, ci_low: -0.0112, ci_high: 0.0262, p: 0.43, stars: "" }],
      globalStatus: "ok",
    }));
    expect(markup).toContain(">+0.026<");
    const scatter = renderToStaticMarkup(createElement(BinScatterChart, {
      bins: bins([-0.02, 0, 0.03], 0.00752), slope: 0.00752, slopeUnit: "个百分点", xLabel: "X", yLabel: "Y", yScale: 100,
    }));
    expect(slopeLabel(scatter).textContent).toBe("斜率：X 每高 1 个百分点，Y 平均相差 +0.008 个百分点");
  });

  test("a position-index slope has the headline's 4 decimals", () => {
    const markup = renderToStaticMarkup(createElement(BinScatterChart, {
      bins: bins([-0.02, 0, 0.03], 0.00077), slope: 0.00077, slopeUnit: "个位置指数单位",
      slopeWords: { lower: "低", higher: "高" }, xLabel: "X", yLabel: "Y",
    }));
    expect(slopeLabel(markup).textContent).toBe("斜率：X 每高 1 个百分点，Y 平均高 0.0008 个位置指数单位");
  });

  test.each([
    [[-0.5, -0.2, 0, 0.05]],
    [[-0.05, 0, 0.2, 0.5]],
    [[-0.3, 0, 0.3]],
  ])("the slope label never crosses the dashed x = 0 line (bins at %p)", (xs) => {
    const markup = renderToStaticMarkup(createElement(BinScatterChart, {
      bins: bins(xs, -0.55), slope: -0.55, slopeUnit: "个中心性原始单位",
      slopeWords: { lower: "低", higher: "高" }, xLabel: "X", yLabel: "Y",
    }));
    const dom = parse(markup);
    const zero = [...dom.querySelectorAll("line")].find((line) => line.getAttribute("stroke-dasharray") === "4 3" && line.getAttribute("x1") === line.getAttribute("x2"))!;
    const zeroX = Number(zero.getAttribute("x1"));
    const label = slopeLabel(markup);
    const anchorX = Number(label.getAttribute("x"));
    const spans = [...label.querySelectorAll("tspan")];
    const lines = spans.length ? spans.map((node) => node.textContent ?? "") : [label.textContent ?? ""];
    const width = Math.max(...lines.map((line) => svgTextWidth(line, 11)));
    const [left, right] = label.getAttribute("text-anchor") === "end" ? [anchorX - width, anchorX] : [anchorX, anchorX + width];
    expect(right < zeroX || left > zeroX).toBe(true);
    expect(left).toBeGreaterThanOrEqual(64);
    expect(right).toBeLessThanOrEqual(640 - 20);
  });

  test("a narrow-interval note is kept inside the plot, right of the row labels", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{ name: "x", coef: -39.7, ci_low: -39.81, ci_high: -39.59, p: 0.001, stars: "" }],
      globalStatus: "ok",
    }));
    const note = parse(markup).querySelector("[data-narrow-ci]")!;
    expect(note.textContent).toBe("区间很窄 [-39.81, -39.59]，在图上与点重合");
    expect(Number(note.getAttribute("x")) - svgTextWidth(note.textContent!, 10.5) / 2).toBeGreaterThanOrEqual(150);
  });

  test("the in-chart estimate of a weak Y says its direction is open", () => {
    const years = [2016, 2017, 2018, 2019, 2020];
    const series = (end: number) => years.map((year, index) => ({ year, change: index < 2 ? 0 : end }));
    const props = { years, policyYear: 2018, taxed: series(0.0042), untaxed: series(0.004), scale: 100, unit: "个百分点", title: "t" };
    const uncertain = renderToStaticMarkup(createElement(GroupChangeChart, {
      ...props, estimate: { gap: 0.0002, label: "回归估计的差距 +0.02 个百分点", uncertain: true },
    }));
    expect(uncertain).toContain("（方向不确定）");
    const settled = renderToStaticMarkup(createElement(GroupChangeChart, {
      ...props, estimate: { gap: 0.0002, label: "回归估计的差距 +0.02 个百分点" },
    }));
    expect(settled).not.toContain("方向不确定");
  });
});
