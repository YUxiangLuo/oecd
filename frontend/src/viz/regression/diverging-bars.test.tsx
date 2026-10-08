import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { barFigures, barUnitFor, type BarEstimate } from "../../regression-verdict";
import type { DepvarKind } from "../../types";
import { svgTextWidth } from "./charts";
import { DivergingBarChart, endLabel, layoutDivergingBars, unitTitleX, type DivergingBarRow } from "./diverging-bars";
import { NEGATIVE, POSITIVE, UNCERTAIN, ZERO_LINE } from "./palette";

afterEach(cleanup);

// Release b973ea5c's teaching overview (coef per unit of X); the depvar_std values are of the right size.
const estimate = (coef: number, low: number, high: number, std = 0.1): BarEstimate => ({ coef, ci_low: low, ci_high: high, depvar_std: std, suppressed: false });
const rowsOf = (items: [string, DepvarKind, BarEstimate][], selected?: string): DivergingBarRow[] => {
  const unit = barUnitFor(items.map(([, kind]) => kind));
  return items.map(([label, kind, value]) => ({ key: label, label, ...barFigures(value, kind, unit), selected: label === selected }));
};
const STEP11 = rowsOf([
  ["外国增加值项占比", "share", estimate(-0.5493, -0.5711, -0.5274)],
  ["国内增加值出口占比", "share", estimate(0.5561, 0.535, 0.577)],
], "外国增加值项占比");
const STEP12 = rowsOf([
  ["复杂 GVC 生产份额", "share", estimate(-0.3756, -0.39, -0.36)],
  ["前向 GVC 生产总份额", "share", estimate(-0.6801, -0.70, -0.66)],
  ["后向 GVC 生产总份额", "share", estimate(-0.4475, -0.46, -0.43)],
  ["简单 GVC 生产份额", "share", estimate(-0.3045, -0.32, -0.29)],
  ["传统贸易生产份额", "share", estimate(-0.2950, -0.31, -0.28)],
  ["纯国内生产份额", "share", estimate(0.9752, 0.95, 1.0)],
  ["后向复杂 GVC 生产份额", "share", estimate(0.00752, -0.0112, 0.0262)],
], "后向复杂 GVC 生产份额");
const STEP14 = rowsOf([
  ["加权总度", "network", estimate(-4010.70, -4100, -3920, 850)],
  ["加权入度", "network", estimate(-1991.05, -2050, -1930, 430)],
  ["加权出度", "network", estimate(-2019.65, -2080, -1960, 430)],
  ["介数", "network", estimate(-6011.39, -6400, -5600, 1300)],
  ["接近中心性", "network", estimate(-0.4871, -0.52, -0.45, 0.11)],
], "加权总度");

/** Content widths of the chart at 1024 and 1280 px windows (sidebar, page and card padding taken off). */
const WIDTHS = [650, 860];

describe("diverging bar layout", () => {
  test.each(WIDTHS.flatMap((width) => [STEP11, STEP12, STEP14].map((rows) => [width, rows] as const)))(
    "at %ipx every text stays inside, names in the left column, end labels away from 0 and past their whisker",
    (width, rows) => {
      const layout = layoutDivergingBars(rows, width);
      for (const placed of layout.rows) {
        const nameWidth = svgTextWidth(placed.row.label, 12.5);
        expect(layout.columnRight - nameWidth).toBeGreaterThanOrEqual(0);
        expect(layout.columnRight).toBeLessThan(layout.plotLeft);
        const [left, right] = placed.anchor === "start" ? [placed.labelX, placed.labelX + placed.labelWidth] : [placed.labelX - placed.labelWidth, placed.labelX];
        expect(left).toBeGreaterThanOrEqual(layout.plotLeft - 0.5);
        expect(right).toBeLessThanOrEqual(width + 0.5);
        // Never across the zero line, the bar or its whisker.
        const farLeft = Math.min(placed.x0, placed.whisker?.[0] ?? placed.x0, layout.zeroX);
        const farRight = Math.max(placed.x1, placed.whisker?.[1] ?? placed.x1, layout.zeroX);
        if (placed.anchor === "start") expect(left).toBeGreaterThan(farRight);
        else expect(right).toBeLessThan(farLeft);
        expect(placed.x0).toBeGreaterThanOrEqual(layout.plotLeft - 0.5);
        expect(placed.x1).toBeLessThanOrEqual(width);
      }
      // Rows are farther apart than the text is tall, so no two end labels or names share a line.
      const ys = layout.rows.map((placed) => placed.y);
      for (let index = 1; index < ys.length; index++) expect(ys[index] - ys[index - 1]).toBeGreaterThanOrEqual(30);
      // Ticks stay in the plot and include the zero line.
      expect(layout.ticks.every((tick) => tick.x >= layout.plotLeft - 0.5 && tick.x <= layout.plotRight + 0.5)).toBe(true);
      expect(layout.ticks.some((tick) => tick.value === 0 && Math.abs(tick.x - layout.zeroX) < 1e-6)).toBe(true);
      // The bars use the room: the widest reaches at least a third of the plot.
      const span = layout.plotRight - layout.plotLeft;
      expect(Math.max(...layout.rows.map((placed) => placed.x1 - placed.x0))).toBeGreaterThan(span / 3);
    },
  );

  test("an all-negative family puts the zero line near the right edge, so the bars use the width", () => {
    const layout = layoutDivergingBars(STEP14, 650);
    expect(layout.zeroX).toBeGreaterThan(layout.plotRight - 40);
  });

  test("the axis title stays inside the drawing", () => {
    const layout = layoutDivergingBars(STEP12, 650);
    const text = "X 每高 1 个百分点，Y 平均相差（个百分点）";
    const centre = unitTitleX(layout, text);
    expect(centre - svgTextWidth(text, 11.5) / 2).toBeGreaterThanOrEqual(0);
    expect(centre + svgTextWidth(text, 11.5) / 2).toBeLessThanOrEqual(650);
  });
});

describe("DivergingBarChart", () => {
  const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");

  test("colours by direction: red positive, blue negative, grey when the interval includes 0, with 方向不确定 beside it", () => {
    const dom = parse(renderToStaticMarkup(<DivergingBarChart rows={STEP12} unitTitle="个百分点" width={650} />));
    const fill = (key: string) => dom.querySelector(`[data-bar="${key}"] path`)?.getAttribute("fill");
    expect(fill("纯国内生产份额")).toBe(POSITIVE);
    expect(fill("复杂 GVC 生产份额")).toBe(NEGATIVE);
    expect(fill("后向复杂 GVC 生产份额")).toBe(UNCERTAIN);
    expect(dom.querySelector('[data-bar="后向复杂 GVC 生产份额"] [data-end-label]')?.textContent).toBe("+0.008 · 方向不确定");
    expect(dom.querySelector('[data-bar="复杂 GVC 生产份额"] [data-end-label]')?.textContent).toBe("-0.38");
    // Every bar has its 95% whisker; the zero line is drawn in ZERO_LINE.
    expect(dom.querySelectorAll("[data-whisker]")).toHaveLength(7);
    expect([...dom.querySelectorAll("line")].some((line) => line.getAttribute("stroke") === ZERO_LINE)).toBe(true);
  });

  test("the selected bar is outlined and tagged 已保存; a static chart is one image with its values in the label", () => {
    const markup = renderToStaticMarkup(<DivergingBarChart rows={STEP11} unitTitle="X 每高 1 个百分点，Y 平均相差（个百分点）" width={860} />);
    const dom = parse(markup);
    const selected = dom.querySelector('[data-selected="true"]')!;
    expect(selected.querySelector("path")?.getAttribute("stroke")).toBe(ZERO_LINE);
    expect(selected.querySelector("[data-selected-tag]")?.textContent).toBe("已保存");
    const svg = dom.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("X 每高 1 个百分点，Y 平均相差（个百分点）。外国增加值项占比：-0.55，已保存；国内增加值出口占比：+0.56");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 860 ${10 + 2 * 42 + 44}`);
    expect(dom.querySelector('[role="button"]')).toBeNull();
  });

  test("a suppressed interval draws no whisker and says so in the tooltip text", () => {
    const rows: DivergingBarRow[] = [{ key: "a", label: "加权总度", value: -0.05, low: null, high: null, uncertain: true, valueLabel: "-40.11（0.047 个标准差）", note: "这次的数据不够判断方向，不显示 95% 区间" }];
    const dom = parse(renderToStaticMarkup(<DivergingBarChart rows={rows} unitTitle="个标准差" width={650} />));
    expect(dom.querySelector("[data-whisker]")).toBeNull();
    expect(dom.querySelector("path")?.getAttribute("fill")).toBe(UNCERTAIN);
    expect(endLabel(rows[0])).toBe("-40.11（0.047 个标准差） · 方向不确定");
  });

  test("bars are buttons: arrows move between them, Enter and Space select, and a run in flight blocks selecting", () => {
    const onSelect = mock((_key: string) => {});
    const { container, rerender } = render(<DivergingBarChart rows={STEP11} unitTitle="个百分点" onSelect={onSelect} width={650} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("group");
    const bars = [...container.querySelectorAll<SVGGElement>('[role="button"]')];
    expect(bars.map((bar) => bar.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    expect(bars[0].getAttribute("aria-pressed")).toBe("true");
    expect(bars[1].getAttribute("aria-label")).toBe("国内增加值出口占比：+0.56");
    bars[0].focus();
    fireEvent.keyDown(bars[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(bars[1]);
    fireEvent.keyDown(bars[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(bars[0]);
    fireEvent.keyDown(bars[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(bars[1]);
    fireEvent.keyDown(bars[1], { key: "Enter" });
    fireEvent.keyDown(bars[1], { key: " " });
    fireEvent.click(bars[1]);
    expect(onSelect.mock.calls.map(([key]) => key)).toEqual(["国内增加值出口占比", "国内增加值出口占比", "国内增加值出口占比"]);
    rerender(<DivergingBarChart rows={STEP11} unitTitle="个百分点" onSelect={onSelect} width={650} disabled />);
    const busy = container.querySelectorAll<SVGGElement>('[role="button"]')[1];
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    fireEvent.keyDown(busy, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});
