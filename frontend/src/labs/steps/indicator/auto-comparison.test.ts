import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import { autoComparisonCountries, materialMatches } from "./auto-comparison";
import { indicatorComparisonPatch } from "./indicator-table";

const meta = { countries: ["ARG", "CHN", "DEU", "ROW", "USA"] } as unknown as Meta;

describe("steps 2–4 automatic report material", () => {
  test("pairs the decomposition country with USA by default, or with CHN when the student picks USA", () => {
    expect(autoComparisonCountries(meta, "DEU")).toEqual(["DEU", "USA"]);
    expect(autoComparisonCountries(meta, "USA")).toEqual(["USA", "CHN"]);
    // No explicit choice yet: the decomposition defaults to China.
    expect(autoComparisonCountries(meta, "")).toEqual(["CHN", "USA"]);
  });

  test("uses the comparison country the student picked (object B), unless it is missing or the same country", () => {
    expect(autoComparisonCountries(meta, "ARG", "DEU")).toEqual(["ARG", "DEU"]);
    expect(autoComparisonCountries(meta, "DEU", "DEU")).toEqual(["DEU", "USA"]);
    expect(autoComparisonCountries(meta, "ARG", "PRT")).toEqual(["ARG", "USA"]);
  });

  test("records a same-year two-country comparison marked as automatic", () => {
    const rows = [
      { country: "CHN", FVA_share: 0.1173 },
      { country: "USA", FVA_share: 0.0551 },
    ];
    const patch = indicatorComparisonPatch(rows, ["CHN", "USA"], 2020, "FVA_share", "%", "rel-1", "auto-indicator-comparison");
    expect(patch?.compared).toEqual(["CHN", "USA"]);
    expect(patch?.observations?.map((item) => [item.country, item.value, item.source])).toEqual([
      ["CHN", 0.1173, "auto-indicator-comparison"],
      ["USA", 0.0551, "auto-indicator-comparison"],
    ]);
    // Step 5 keeps the explicit default.
    expect(indicatorComparisonPatch(rows, ["CHN", "USA"], 2020, "FVA_share", "%", "rel-1")?.observations?.[0].source)
      .toBe("explicit-indicator-table-comparison");
  });
});

describe("matching saved material to the current selection", () => {
  test("ignores key order from the server but notices a different comparison country", () => {
    const rows = [{ country: "ARG", GVCPs: 0.953 }, { country: "PRT", GVCPs: 0.992 }, { country: "USA", GVCPs: 1.002 }];
    const patch = indicatorComparisonPatch(rows, ["ARG", "PRT"], 2020, "GVCPs", "无量纲", "rel-1", "auto-indicator-comparison");
    const reordered = JSON.parse(JSON.stringify(patch), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value);
    expect(materialMatches(patch, reordered)).toBe(true);
    const usa = indicatorComparisonPatch(rows, ["ARG", "USA"], 2020, "GVCPs", "无量纲", "rel-1", "auto-indicator-comparison");
    expect(materialMatches(patch, usa ?? undefined)).toBe(false);
    expect(materialMatches(null, reordered)).toBe(false);
  });
});

describe("automatic material status line", () => {
  test("shows what was recorded once two observations exist", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AutoMaterialStatus } = await import("./auto-comparison");
    const observations = ["CHN", "USA"].map((country, index) => ({
      entity: country, country, industry: "", year: 2020, value: index ? 9 : 12, metric: "weighted degree",
      unit: "百万美元", release: "rel-1", scope: "country" as const, source: "auto-indicator-comparison" as const,
    }));
    const props = {
      meta, state: { data: { observations }, save: () => {}, complete: false, syncing: false, syncError: null, syncNow: () => {} },
      schema: null, first: "CHN", second: "USA", onSecond: () => {}, loadFailed: false, where: "上方表格所选国家",
    };
    const html = renderToStaticMarkup(createElement(AutoMaterialStatus, { ...props, current: true }));
    expect(html).toContain("报告材料 · 自动记录");
    expect(html).toContain("2020 年 · CHN 中国");
    expect(html).toContain("USA 美国");
    expect(html).toContain("对比国家");
    expect(html).toContain("记录上方表格所选国家和对比国家");
    expect(html).not.toContain("选美国时");
    // A saved record from an earlier selection is not shown as if it matched the current one.
    const stale = renderToStaticMarkup(createElement(AutoMaterialStatus, { ...props, current: false }));
    expect(stale).not.toContain("2020 年 · CHN 中国");
    expect(stale).toContain("正在记录当前选择");
  });
});
