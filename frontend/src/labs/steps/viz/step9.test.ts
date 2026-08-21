import { describe, expect, test } from "bun:test";
import { NEGATIVE_COMPOSITION_STYLE, sortCompositionRows } from "../../../viz/explore/charts";
import { CAT } from "../../../viz/shared";
import { complexGvcRankRows, eligibleProductionCompositionRows, PROD_SEGMENTS, PRODUCTION_LADDER_GUIDE, PRODUCTION_LADDER_SORT, productionIndustryRequestKey } from "./step9";

describe("step 8 production ladder reading contract", () => {
  test("binds actual segment names to the rendered palette", () => {
    expect(PROD_SEGMENTS.map(({ key, colorName, color }) => [key, colorName, color])).toEqual([
      ["1_VA_D", "蓝色", CAT[0]],
      ["2_VA_RT", "绿色", CAT[1]],
      ["3a_VA_GVC_S", "琥珀色", CAT[2]],
      ["3b_VA_GVC_C", "深绿色", CAT[3]],
    ]);
  });

  test("uses the same descending sort contract stated by the copy", () => {
    const rows = [
      { country: "LOW", [PRODUCTION_LADDER_SORT.key]: 0.02 },
      { country: "HIGH", [PRODUCTION_LADDER_SORT.key]: 0.14 },
      { country: "MID", [PRODUCTION_LADDER_SORT.key]: 0.08 },
    ];
    expect(sortCompositionRows(rows, PRODUCTION_LADDER_SORT.key, PRODUCTION_LADDER_SORT.direction)
      .map((row) => row.country)).toEqual(["HIGH", "MID", "LOW"]);
    expect(PRODUCTION_LADDER_GUIDE).toContain("从高到低排序");
    expect(PRODUCTION_LADDER_GUIDE).toContain("从上到下");
    expect(PRODUCTION_LADDER_GUIDE).toContain("总体递减");
  });

  test("requires finite sort, authoritative total and every rendered segment", () => {
    const complete = Object.fromEntries([
      ["country", "OK"],
      ["SVA", 100],
      [PRODUCTION_LADDER_SORT.key, 0.2],
      ...PROD_SEGMENTS.map((segment, index) => [segment.key, index - 1]),
    ]);
    for (const required of ["SVA", PRODUCTION_LADDER_SORT.key, ...PROD_SEGMENTS.map((segment) => segment.key)]) {
      const invalid = { ...complete, [required]: null };
      expect(eligibleProductionCompositionRows([complete, invalid], PRODUCTION_LADDER_SORT.key)
        .map((row) => row.country)).toEqual(["OK"]);
    }
  });

  test("complex-GVC ranking appends a selected country outside Top 20 once", () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      country: `C${String(index).padStart(2, "0")}`,
      "3b_VA_GVC_C_share": 30 - index,
    }));
    expect(complexGvcRankRows([...rows, { ...rows[20] }], ["C20", "C20"]).map((row) => row.country))
      .toEqual(rows.map((row) => row.country));
  });

  test("industry fetch identity includes release, year and country", () => {
    const meta = { dataset: { years: [2019, 2020], release_id: "a".repeat(32) } };
    expect(productionIndustryRequestKey(meta, 2020, "CHN"))
      .toBe(`${"a".repeat(32)}:2020:country-industry:CHN`);
    expect(productionIndustryRequestKey(meta, 2019, "CHN"))
      .not.toBe(productionIndustryRequestKey(meta, 2020, "CHN"));
    expect(productionIndustryRequestKey(meta, 2020, "USA"))
      .not.toBe(productionIndustryRequestKey(meta, 2020, "CHN"));
    expect(productionIndustryRequestKey(meta, 2020, "")).toBeNull();
    expect(productionIndustryRequestKey({ dataset: undefined }, 2020, "CHN")).toBeNull();
  });

  test("names the actual simple/complex colors and the shared negative override", () => {
    expect(PRODUCTION_LADDER_GUIDE).toContain("琥珀色 简单 GVC");
    expect(PRODUCTION_LADDER_GUIDE).toContain("深绿色 复杂 GVC");
    expect(PRODUCTION_LADDER_GUIDE).toContain(`统一以${NEGATIVE_COMPOSITION_STYLE.colorName}显示在零轴左侧`);
    expect(PRODUCTION_LADDER_GUIDE).not.toContain("红/橙段");
    expect(PRODUCTION_LADDER_GUIDE).not.toContain("越来越宽");
  });
});
