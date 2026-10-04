import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import { autoComparisonCountries } from "./calculation-step";
import { indicatorComparisonPatch } from "./indicator-table";

const meta = { countries: ["ARG", "CHN", "DEU", "ROW", "USA"] } as unknown as Meta;

describe("steps 2–4 automatic report material", () => {
  test("pairs the decomposition country with USA, or with CHN when the student picks USA", () => {
    expect(autoComparisonCountries(meta, "DEU")).toEqual(["DEU", "USA"]);
    expect(autoComparisonCountries(meta, "USA")).toEqual(["USA", "CHN"]);
    // No explicit choice yet: the decomposition defaults to China.
    expect(autoComparisonCountries(meta, "")).toEqual(["CHN", "USA"]);
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
