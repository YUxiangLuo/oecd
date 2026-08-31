import { describe, expect, test } from "bun:test";
import { compositionSegmentColor, NEGATIVE_COMPOSITION_STYLE } from "../../../viz/explore/charts";
import { CAT } from "../../../viz/shared";
import { eligibleExportCompositionRows, WWZ_READING_GUIDE, WWZ_SEGMENTS } from "./trade";

describe("step 7 export decomposition provenance copy", () => {
  test("binds every legend segment to the correct provenance and palette slot", () => {
    expect(WWZ_SEGMENTS.map(({ key, provenance }) => [key, provenance])).toEqual([
      ["DVAex", "domestic"],
      ["DVArt", "domestic"],
      ["DDC", "domestic"],
      ["FVA", "foreign"],
      ["FDC", "foreign"],
      ["taxsub", "extension"],
    ]);
    expect(WWZ_SEGMENTS.map(({ color }) => color)).toEqual(CAT);
  });

  test("derives the reading instruction from every adjacent legend entry", () => {
    for (const segment of WWZ_SEGMENTS) {
      expect(WWZ_READING_GUIDE).toContain(`${segment.colorName} ${segment.key}`);
    }
    expect(WWZ_READING_GUIDE).toContain("正值时");
    expect(WWZ_READING_GUIDE).toContain("属于国内增加值及其重复计算");
    expect(WWZ_READING_GUIDE).toContain("属于外国增加值及其重复计算");
    expect(WWZ_READING_GUIDE).toContain("是 OECD TLS 账户扩展");
  });

  test("requires the authoritative gross-export total and every rendered segment", () => {
    const complete = Object.fromEntries([
      ["country", "OK"],
      ["gross_exports", 21],
      ...WWZ_SEGMENTS.map((segment, index) => [segment.key, index - 2]),
    ]);
    for (const required of ["gross_exports", ...WWZ_SEGMENTS.map((segment) => segment.key)]) {
      const invalid = { ...complete, [required]: null };
      expect(eligibleExportCompositionRows([complete, invalid]).map((row) => row.country)).toEqual(["OK"]);
    }
  });

  test("uses and explains the shared red negative override without changing provenance", () => {
    for (const [index, segment] of WWZ_SEGMENTS.entries()) {
      expect(compositionSegmentColor(segment, index, false)).toBe(segment.color);
      expect(compositionSegmentColor(segment, index, true)).toBe(NEGATIVE_COMPOSITION_STYLE.color);
    }
    expect(WWZ_READING_GUIDE).toContain(`负分项统一以${NEGATIVE_COMPOSITION_STYLE.colorName}显示在零轴左侧`);
    expect(WWZ_READING_GUIDE).toContain("不改变其国内、外国或 TLS 扩展归类");
  });
});
