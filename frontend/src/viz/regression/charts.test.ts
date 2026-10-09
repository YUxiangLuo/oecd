import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupChangeChart, spreadLabels } from "./charts";

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
