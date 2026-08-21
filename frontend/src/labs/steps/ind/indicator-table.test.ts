import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import {
  INDICATOR_TABLE_DISPLAY,
  countryObservation,
  countryRowsForYear,
  indicatorMetricColumns,
  indicatorRequestKey,
  indicatorTableColumns,
  restoreIndicatorSelection,
  sortNetworkRows,
} from "./indicator-table";

const meta = {
  years: [2018, 2019, 2020],
  countries: ["CHN", "USA", "JPN"],
} as Meta;

describe("indicator selection restoration", () => {
  test("restores the saved year and most recent compared country", () => {
    expect(restoreIndicatorSelection(meta, {
      year: 2019,
      compared: ["CHN", "USA"],
    })).toEqual({ year: 2019, country: "USA" });
  });

  test("ignores selections that are absent from the active artifact", () => {
    expect(restoreIndicatorSelection(meta, {
      year: 2016,
      country: "GBR",
    })).toEqual({ year: 2020, country: "CHN" });
  });

  test("preserves an explicitly restored global country selection", () => {
    expect(restoreIndicatorSelection(meta, { country: "" }))
      .toEqual({ year: 2020, country: "" });
  });

  test("country comparison uses the country-level metric, not the first industry", () => {
    expect(countryObservation(
      [
        { country: "USA", FVA_share: 0.12, industry: "A01_02" },
        { country: "SGP", FVA_share: 0.28 },
      ],
      "SGP",
      2020,
      "FVA_share",
    )).toEqual({
      entity: "SGP",
      value: 0.28,
      year: 2020,
      country: "SGP",
      industry: "",
    });
  });

  test("prefers a country total over an industry row for the same country", () => {
    expect(countryObservation(
      [
        { country: "USA", FVA_share: 0.12, industry: "A01_02" },
        { country: "USA", FVA_share: 0.19 },
      ],
      "USA",
      2019,
      "FVA_share",
    )?.value).toBe(0.19);
  });

  test("ignores country rows tagged with a different year", () => {
    expect(countryRowsForYear({ year: 2019, rows: [{ country: "USA", FVA_share: 0.12 }] }, 2020)).toBeNull();
    expect(countryRowsForYear({ year: 2020, rows: [{ country: "USA", FVA_share: 0.12 }] }, 2020)).toEqual([
      { country: "USA", FVA_share: 0.12 },
    ]);
  });
});

describe("indicator table request and display contracts", () => {
  test("keys the main request by year, country and page", () => {
    expect(indicatorRequestKey(2020, "CHN", 2)).toBe('[2020,"CHN",2]');
    expect(indicatorRequestKey(2020, "CHN", 2)).not.toBe(indicatorRequestKey(2020, "USA", 2));
    expect(indicatorRequestKey(2020, "CHN", 2)).not.toBe(indicatorRequestKey(2019, "CHN", 2));
    expect(indicatorRequestKey(2020, "CHN", 2)).not.toBe(indicatorRequestKey(2020, "CHN", 1));
  });

  test("uses exact task columns instead of the schema's generic first five", () => {
    const productionFields = [
      "SVA", "1_VA_D", "2_VA_RT", "3_VA_GVC", "3a_VA_GVC_S", "3b_VA_GVC_C",
      "FGY", "3b_VA_GVC_C_share",
    ];
    const productionRow = Object.fromEntries(productionFields.map((field) => [field, 1]));
    expect(indicatorMetricColumns("production", productionFields, productionRow)).toEqual([
      "SVA", "1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C", "3b_VA_GVC_C_share",
    ]);
    expect(indicatorTableColumns("production", productionFields, productionRow)).toEqual([
      "country", "industry", "year",
      "SVA", "1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C", "3b_VA_GVC_C_share",
    ]);
    expect(INDICATOR_TABLE_DISPLAY.network).toEqual([
      "weighted degree", "betweenesscentrality", "degree", "indegree", "outdegree", "closnesscentrality",
    ]);
  });

  test("expansion preserves all schema fields after the task-first default", () => {
    const fields = ["SVA", "1_VA_D", "2_VA_RT", "3_VA_GVC", "3b_VA_GVC_C_share"];
    const row = Object.fromEntries(fields.map((field) => [field, 1]));
    expect(indicatorMetricColumns("production", fields, row, true)).toEqual(fields);
  });

  test("sorts a complete country response by either metric with stable ties", () => {
    const rows = [
      { industry: "A", "weighted degree": 4, betweenesscentrality: 2 },
      { industry: "B", "weighted degree": 9, betweenesscentrality: 7 },
      { industry: "C", "weighted degree": 9, betweenesscentrality: 2 },
      { industry: "D", "weighted degree": null, betweenesscentrality: 7 },
    ];
    expect(sortNetworkRows(rows, "weighted degree").map((row) => row.industry)).toEqual(["B", "C", "A", "D"]);
    expect(sortNetworkRows(rows, "betweenesscentrality").map((row) => row.industry)).toEqual(["B", "D", "A", "C"]);
    expect(rows.map((row) => row.industry)).toEqual(["A", "B", "C", "D"]);
  });
});
