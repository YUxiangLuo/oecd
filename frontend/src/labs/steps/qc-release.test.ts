import { describe, expect, test } from "bun:test";
import { summarizeQcRelease } from "./qc-release";

describe("manifest QC disclosure", () => {
  test("finds nested year/control summaries and deduplicates names", () => {
    expect(summarizeQcRelease({
      years: { "2020": { requires_disclosure: true, override: true, fatal: ["Leontief"], warning: ["边界"] } },
      controls: { requires_disclosure: true, warning: ["边界"], disclosure: ["模拟宏观数据"] },
    })).toEqual({
      requiresDisclosure: true,
      override: true,
      fatal: ["Leontief"],
      warning: ["边界"],
      disclosure: ["模拟宏观数据"],
    });
  });

  test("does not invent a warning for a clean or absent manifest", () => {
    expect(summarizeQcRelease(undefined).requiresDisclosure).toBe(false);
    expect(summarizeQcRelease({ years: { "2020": { requires_disclosure: false } } }).requiresDisclosure).toBe(false);
  });
});
