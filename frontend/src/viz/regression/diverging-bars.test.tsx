import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { barFigures, barUnitFor, type BarEstimate } from "../../regression-verdict";
import type { DepvarKind } from "../../types";
import { svgTextWidth } from "./charts";
import { DivergingBarChart, endLabel, endLabelLines, layoutDivergingBars, SELECT_TIP, spokenBar, unitTitleX, type DivergingBarRow } from "./diverging-bars";
import { NEGATIVE, POSITIVE, UNCERTAIN, ZERO_LINE } from "./palette";

afterEach(cleanup);

test("clearing unselected rows dismisses the old readout", () => {
  const rows = [{ key: "a", label: "old reading", value: 1, valueLabel: "1", low: 0.5, high: 1.5, uncertain: false }];
  const view = render(<DivergingBarChart rows={rows} unitTitle="unit" />);
  fireEvent.mouseMove(view.container.querySelector("[data-bar]")!, { clientX: 100, clientY: 100 });
  const tip = view.container.firstElementChild!.lastElementChild as HTMLElement;
  expect(tip.textContent).toContain("old reading");
  expect(tip.style.opacity).toBe("1");
  view.rerender(<DivergingBarChart rows={[{ ...rows[0], valueLabel: "updated reading" }]} unitTitle="unit" />);
  expect(tip.style.opacity).toBe("0");
  fireEvent.mouseMove(view.container.querySelector("[data-bar]")!, { clientX: 100, clientY: 100 });
  expect(tip.textContent).toContain("updated reading");
  expect(tip.style.opacity).toBe("1");
  view.rerender(<DivergingBarChart rows={[]} unitTitle="unit" />);
  expect(tip.style.opacity).toBe("0");
});

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

// Step 15's summary as the page builds it (regressionSummaryRows): native value with its unit, signed size in SD.
// depvar_std values chosen so the sizes are those of the course release (-0.062, +0.001, -0.004, -0.047 SD).
const SUMMARY: DivergingBarRow[] = ([
  ["trade", "外国增加值项占比", "步骤 11 · 贸易流", "share", estimate(-0.5493, -0.5711, -0.5274, 0.0887)],
  ["production", "后向复杂 GVC 生产份额", "步骤 12 · 生产", "share", estimate(0.00752, -0.0112, 0.0262, 0.058)],
  ["length", "GVC 位置指数", "步骤 13 · 长度", "position", estimate(-0.0768, -0.112, -0.041, 0.1736)],
  ["network", "加权总度", "步骤 14 · 网络", "network", estimate(-4010.70, -4100, -3920, 852.8)],
] as [string, string, string, DepvarKind, BarEstimate][]).map(([key, label, sublabel, kind, value]) => ({
  key, label, sublabel, ...barFigures(value, kind, "sd", true),
}));
/**
 * Drawing widths of that chart at 900, 1024 and 1280 px windows: the window (900 is laid out at the 1000 px
 * minimum width), minus the sidebar (240 below 1200 px, else 288), the content padding (2 × 18 / 2 × 26), the
 * "查看已保存的四项回归结果" box (2 × 17) and the chart card (2 × 16).
 */
const SUMMARY_WIDTHS = [[900, 1000 - 240 - 36 - 34 - 32], [1024, 1024 - 240 - 36 - 34 - 32], [1280, 1280 - 288 - 52 - 34 - 32]];

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

  test("step 15's summary has the same axis range at every window width (only the tick density varies)", () => {
    // 1440 px read −0.1…0 while 1024 px (and the report) read −0.15…0.
    const ends = [...SUMMARY_WIDTHS.map(([, width]) => width), 420, 980].map((width) => {
      const ticks = layoutDivergingBars(SUMMARY, width).ticks.map((tick) => tick.value);
      return [ticks[0], ticks.at(-1)];
    });
    for (const range of ends) expect(range).toEqual(ends[0]);
  });

  test.each(SUMMARY_WIDTHS)("step 15's summary at a %ipx window (drawn %ipx wide): finite ticks, bars that use the plot, labels inside", (_window, width) => {
    const layout = layoutDivergingBars(SUMMARY, width);
    // Drawn at the container's width: text keeps its size.
    expect(layout.width).toBe(width);
    // The axis is in standard deviations of about ±0.1: never ±2e14 (k fell to 1e-12 when the labels did not fit).
    expect(layout.ticks.length).toBeGreaterThanOrEqual(3);
    for (const tick of layout.ticks) {
      expect(Number.isFinite(tick.value)).toBe(true);
      expect(Math.abs(tick.value)).toBeLessThan(1);
      expect(tick.text).toMatch(/^-?\d(\.\d+)?$/);
    }
    expect(layout.ticks.some((tick) => tick.value === 0 && Math.abs(tick.x - layout.zeroX) < 1e-6)).toBe(true);
    const span = layout.plotRight - layout.plotLeft;
    expect(Math.max(...layout.rows.map((placed) => placed.x1 - placed.x0))).toBeGreaterThan(span / 3);
    for (const placed of layout.rows) {
      const [left, right] = placed.anchor === "start" ? [placed.labelX, placed.labelX + placed.labelWidth] : [placed.labelX - placed.labelWidth, placed.labelX];
      expect(left).toBeGreaterThanOrEqual(layout.plotLeft - 0.5);
      expect(right).toBeLessThanOrEqual(width + 0.5);
      const farLeft = Math.min(placed.x0, placed.whisker?.[0] ?? placed.x0, layout.zeroX);
      const farRight = Math.max(placed.x1, placed.whisker?.[1] ?? placed.x1, layout.zeroX);
      if (placed.anchor === "start") expect(left).toBeGreaterThan(farRight);
      else expect(right).toBeLessThan(farLeft);
      // A stacked label fits its row.
      expect(placed.lines.length * 15).toBeLessThan(placed.height);
      expect(placed.lines.join("").replace(/ · /g, "")).toBe(endLabel(placed.row).replace(/ · /g, ""));
    }
    // The rendered axis says the same.
    const dom = new DOMParser().parseFromString(renderToStaticMarkup(<DivergingBarChart rows={SUMMARY} unitTitle="个标准差" width={width} />), "text/html");
    const tickTexts = [...dom.querySelectorAll("svg > g[aria-hidden='true'] > text")].map((node) => Number(node.textContent));
    expect(tickTexts.length).toBe(layout.ticks.length);
    expect(tickTexts.every((value) => Number.isFinite(value) && Math.abs(value) < 1)).toBe(true);
  });

  test("narrow windows stack the end labels as the report does: value, then standard deviations and 方向不确定", () => {
    expect(layoutDivergingBars(SUMMARY, 682).labelLayout).toBeGreaterThan(0);
    expect(endLabelLines(SUMMARY[1], 1)).toEqual(["+0.008 个百分点", "（+0.001 个标准差） · 方向不确定"]);
    expect(endLabelLines(SUMMARY[1], 2)).toEqual(["+0.008 个百分点", "（+0.001 个标准差）", "方向不确定"]);
    expect(endLabelLines(SUMMARY[0], 2)).toEqual(["-0.55 个百分点", "（-0.062 个标准差）"]);
    // Step 11's short labels stay on one line.
    expect(layoutDivergingBars(STEP11, 650).labelLayout).toBe(0);
    const dom = new DOMParser().parseFromString(renderToStaticMarkup(<DivergingBarChart rows={SUMMARY} unitTitle="个标准差" width={682} />), "text/html");
    const weak = dom.querySelector('[data-bar="production"] [data-end-label]')!;
    expect(weak.querySelectorAll("[data-line]").length).toBeGreaterThan(1);
  });

  test("far below the supported width the chart is drawn wider and scaled down, never with a collapsed axis", () => {
    const layout = layoutDivergingBars(SUMMARY, 300);
    expect(layout.width).toBeGreaterThan(300);
    expect(layout.ticks.every((tick) => Number.isFinite(tick.value) && Math.abs(tick.value) < 1)).toBe(true);
    // The widest bar with its whisker gets at least a sixth of the plot.
    const span = layout.plotRight - layout.plotLeft;
    const reach = (placed: (typeof layout.rows)[number]) =>
      Math.max(placed.x1, placed.whisker?.[1] ?? placed.x1) - Math.min(placed.x0, placed.whisker?.[0] ?? placed.x0);
    expect(Math.max(...layout.rows.map(reach))).toBeGreaterThan(span / 6);
  });

  // The course release's step 15 summary (gvcsim summary_chart), with the weak Y saved in step 12: long end labels on
  // both sides of the zero line, the case that was drawn 940 wide in a 680 card.
  const RELEASE_SUMMARY: DivergingBarRow[] = [
    ["外国增加值项占比", "步骤 11 · 贸易流", -0.0624, -0.06453, -0.06028, "-0.55 个百分点（-0.062 个标准差）"],
    ["后向复杂 GVC 生产份额", "步骤 12 · 生产", 0.0009651, -0.001361, 0.003292, "+0.006 个百分点（+0.001 个标准差）"],
    ["前向 GVC 段长度", "步骤 13 · 长度", -0.03156, -0.03292, -0.0302, "-0.0184 个长度单位（-0.032 个标准差）"],
    ["加权总度", "步骤 14 · 网络", -0.0489, -0.04983, -0.04796, "-40.80 个模拟分数单位（-0.049 个标准差）"],
  ].map(([label, sublabel, value, low, high, valueLabel], index) => ({
    key: String(index), label: String(label), sublabel: String(sublabel), value: Number(value), low: Number(low), high: Number(high),
    uncertain: Number(low) <= 0 && Number(high) >= 0, valueLabel: String(valueLabel),
  }));

  test.each(SUMMARY_WIDTHS)("step 15's release summary at a %ipx window is drawn at the card's width (%ipx), so its text keeps its size", (_window, width) => {
    for (const rows of [SUMMARY, RELEASE_SUMMARY]) {
      const layout = layoutDivergingBars(rows, width);
      expect(layout.width).toBe(width);
      const span = layout.plotRight - layout.plotLeft;
      expect(Math.max(...layout.rows.map((placed) => placed.x1 - placed.x0))).toBeGreaterThan(span / 6);
    }
  });

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
    expect(svg.getAttribute("aria-label")).toBe("X 每高 1 个百分点，Y 平均相差（个百分点）。外国增加值项占比：-0.55 个百分点，95% 区间 [-0.57, -0.53]，已保存；国内增加值出口占比：+0.56 个百分点，95% 区间 [+0.54, +0.58]");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 860 ${10 + 2 * 42 + 44}`);
    expect(dom.querySelector('[role="button"]')).toBeNull();
  });

  test("a bar is read aloud with its unit, its 95% interval, an open direction and whether it is saved", () => {
    const [saved, other] = STEP11;
    expect(spokenBar(saved)).toBe("外国增加值项占比：-0.55 个百分点，95% 区间 [-0.57, -0.53]，已保存");
    expect(spokenBar(other)).toBe("国内增加值出口占比：+0.56 个百分点，95% 区间 [+0.54, +0.58]");
    const weak = STEP12.find((row) => row.uncertain)!;
    expect(spokenBar(weak)).toBe("后向复杂 GVC 生产份额：+0.008 个百分点，95% 区间 [-0.011, +0.026]，方向不确定，已保存");
  });

  test("a suppressed interval draws no whisker and says so in the tooltip text", () => {
    const rows: DivergingBarRow[] = [{ key: "a", label: "加权总度", value: -0.05, low: null, high: null, uncertain: true, valueLabel: "-40.11（-0.047 个标准差）", note: "这次的数据不够判断方向，不显示 95% 区间" }];
    const dom = parse(renderToStaticMarkup(<DivergingBarChart rows={rows} unitTitle="个标准差" width={650} />));
    expect(dom.querySelector("[data-whisker]")).toBeNull();
    expect(dom.querySelector("path")?.getAttribute("fill")).toBe(UNCERTAIN);
    expect(endLabel(rows[0])).toBe("-40.11（-0.047 个标准差） · 方向不确定");
  });

  test("bars are buttons: arrows move between them, Enter and Space select, and a run in flight blocks selecting", () => {
    const onSelect = mock((_key: string) => {});
    const { container, rerender } = render(<DivergingBarChart rows={STEP11} unitTitle="个百分点" onSelect={onSelect} width={650} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("group");
    const bars = [...container.querySelectorAll<SVGGElement>('[role="button"]')];
    expect(bars.map((bar) => bar.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    // The saved Y is said in its name, not as a pressed toggle.
    expect(bars[0].hasAttribute("aria-pressed")).toBe(false);
    expect(bars[0].getAttribute("aria-label")).toMatch(/，已保存$/);
    expect(bars[1].getAttribute("aria-label")).toBe("国内增加值出口占比：+0.56 个百分点，95% 区间 [+0.54, +0.58]");
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

  test("an open tooltip closes when the saved Y changes without a click on the chart", () => {
    const { container, rerender } = render(<DivergingBarChart rows={STEP11} unitTitle="个百分点" onSelect={() => {}} width={650} />);
    const tip = container.querySelector<HTMLElement>(".diverging-bars > div[style*='pointer-events']")!;
    fireEvent.mouseEnter(container.querySelectorAll<SVGGElement>('[role="button"]')[1], { clientX: 300, clientY: 200 });
    expect(tip.style.opacity).toBe("1");
    expect(tip.textContent).toContain(SELECT_TIP);
    // A retry button saved that Y: the tooltip offering to save it must not stay up.
    rerender(<DivergingBarChart rows={STEP11.map((row) => ({ ...row, selected: !row.selected }))} unitTitle="个百分点" onSelect={() => {}} width={650} />);
    expect(tip.style.opacity).toBe("0");
  });

  test("keyboard focus puts the tooltip above the row, not over the lines under the chart", () => {
    const { container } = render(<DivergingBarChart rows={STEP11} unitTitle="个百分点" onSelect={() => {}} width={650}><p>合计 100%</p></DivergingBarChart>);
    const wrap = container.querySelector<HTMLElement>(".diverging-bars")!;
    const tip = container.querySelector<HTMLElement>(".diverging-bars > div[style*='pointer-events']")!;
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    wrap.getBoundingClientRect = () => rect(100, 400);
    Object.defineProperty(tip, "offsetHeight", { configurable: true, value: 80 });
    const [first, last] = [...container.querySelectorAll<SVGGElement>('[role="button"]')];
    last.getBoundingClientRect = () => rect(300, 340);
    fireEvent.focus(last);
    // The row starts 200px into the card: the 80px tip ends 6px above it.
    expect(tip.style.top).toBe(`${200 - 80 - 6}px`);
    // The first row has no room above it inside the chart, but the window does: above it still, over the chart's
    // own legend, not over the next bars.
    first.getBoundingClientRect = () => rect(150, 190);
    fireEvent.focus(first);
    expect(tip.style.top).toBe(`${150 - 100 - 80 - 6}px`);
    // No room in the window either (the chart at the very top): below the row.
    wrap.getBoundingClientRect = () => rect(0, 300);
    first.getBoundingClientRect = () => rect(20, 60);
    fireEvent.focus(first);
    expect(tip.style.top).toBe(`${60 + 6}px`);
  });
});
