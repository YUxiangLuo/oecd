import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { freeSlot, GroupChangeChart, spreadLabels } from "./charts";

describe("two-group chart bracket longer than the gap between the lines", () => {
  test("the taxed group's name stays at its line end; the estimate takes a free place", () => {
    // As on step 13 (GVC 位置指数): the bracket (β × the taxed group's mean X) is longer than the gap between the lines.
    const years = [2016, 2017, 2018, 2019, 2020];
    const series = (end: number) => years.map((year, index) => ({ year, change: index < 2 ? 0 : end }));
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, policyYear: 2018, taxed: series(-0.0007), untaxed: series(0), scale: 1, unit: "无量纲", title: "t",
      estimate: { gap: -0.0016, label: "回归估计的差距 -0.0016" },
    }));
    const taxedEnds = [...markup.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)" r="3.5" fill="#d6731f"/g)].map((match) => Number(match[1]));
    const taxedEnd = taxedEnds.at(-1)!;
    const taxedLabel = Number(/y="([\d.]+)"[^>]*>被加税国家组/.exec(markup)?.[1]);
    const untaxedLabel = Number(/y="([\d.]+)"[^>]*>未被加税国家组/.exec(markup)?.[1]);
    const estimateCentre = Number(/data-estimate-label="true" x="[\d.]+" y="([\d.]+)"/.exec(markup)?.[1]) - 4;
    expect(taxedEnds.length).toBe(5);
    expect(Math.abs(taxedLabel - taxedEnd)).toBeLessThanOrEqual(9);
    // Neither group name overlaps the two-line estimate (28 units tall), nor each other.
    expect(Math.abs(estimateCentre - taxedLabel)).toBeGreaterThanOrEqual(21);
    expect(Math.abs(estimateCentre - untaxedLabel)).toBeGreaterThanOrEqual(21);
    expect(Math.abs(taxedLabel - untaxedLabel)).toBeGreaterThanOrEqual(16);
  });

  test("freeSlot keeps a free wanted place and otherwise moves to the nearest free one", () => {
    expect(freeSlot(100, 28, [40, 160], 14, 20, 216)).toBe(100);
    expect(Math.abs(freeSlot(100, 28, [100], 14, 20, 216) - 100)).toBeGreaterThanOrEqual(23);
    expect(freeSlot(30, 28, [40], 14, 20, 216)).toBeGreaterThanOrEqual(40 + 23);
  });
});

describe("two-group chart readings", () => {
  test("a small negative change that rounds to zero reads 0.0, never -0.0 (table and tooltips)", () => {
    // Step 12: a group's change of -0.0004 points printed "-0.00" in 两组逐年读数.
    const years = [2016, 2017, 2018];
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, policyYear: 2018, scale: 100, unit: "个百分点", title: "t",
      taxed: years.map((year, index) => ({ year, change: [-0.000004, 0.000003, -0.2][index] })),
      untaxed: years.map((year) => ({ year, change: 0 })),
    }));
    expect(markup).not.toMatch(/>-0\.0+</);
    expect(markup).not.toMatch(/：-0\.0+ /);
    expect(markup).toContain("<th scope=\"row\">2016</th><td>0.0</td>");
    expect(markup).toContain("<td>-20.0</td>");
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
    const taxed = at("被加税国家组"), untaxed = at("未被加税国家组");
    expect(Math.abs(taxed - untaxed)).toBeGreaterThanOrEqual(16);
  });
});

describe("two-group chart readings without a mouse", () => {
  test("a folded table gives each year's value for both groups, in the chart's unit", () => {
    const years = [2016, 2017, 2018];
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, policyYear: 2018, scale: 100, unit: "个百分点", title: "加税前后",
      taxed: [{ year: 2016, change: 0 }, { year: 2017, change: 0.001 }, { year: 2018, change: -0.004 }],
      untaxed: [{ year: 2016, change: 0 }, { year: 2017, change: -0.001 }, { year: 2018, change: 0.003 }],
    }));
    const dom = new DOMParser().parseFromString(markup, "text/html");
    const details = dom.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("两组逐年读数");
    expect([...details.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["年份", "被加税组（个百分点）", "未被加税组（个百分点）"]);
    const rows = [...details.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
    // The same values as the dots' tooltips.
    expect(markup).toContain("<title>2018 年：-0.400 个百分点</title>");
    expect(rows).toEqual([["2016", "0.000", "0.000"], ["2017", "0.100", "-0.100"], ["2018（起加税）", "-0.400", "0.300"]]);
  });
});

describe("two-group chart estimate", () => {
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
