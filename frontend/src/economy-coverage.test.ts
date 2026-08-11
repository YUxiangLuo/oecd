import { describe, expect, test } from "bun:test";
import { economyAccountCoverage, economyAccountCoverageLabel } from "./economy-coverage";

describe("OECD ICIO economy-account coverage", () => {
  test("does not count ROW as an economy", () => {
    expect(economyAccountCoverage(["CHN", "USA", "ROW"])).toEqual({
      economies: 2,
      rowAccounts: 1,
      totalAccounts: 3,
    });
    expect(economyAccountCoverageLabel(["CHN", "USA", "ROW"]))
      .toBe("2 个经济体和 1 个“世界其他地区”（ROW）聚合账户");
  });

  test("uses the current course snapshot before metadata is available", () => {
    expect(economyAccountCoverage()).toEqual({
      economies: 76,
      rowAccounts: 1,
      totalAccounts: 77,
    });
  });
});
