import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import {
  INDICATOR_TABLE_DISPLAY,
  countryObservation,
  countryRowsForYear,
  fmtIndicatorCell,
  indicatorMaterialPatch,
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
      "比例",
      "release-1",
    )).toEqual({
      entity: "SGP",
      value: 0.28,
      year: 2020,
      country: "SGP",
      industry: "",
      metric: "FVA_share",
      unit: "比例",
      release: "release-1",
      scope: "country",
      source: "auto-indicator-comparison",
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
      "比例",
      "release-1",
    )?.value).toBe(0.19);
  });

  test("ignores country rows tagged with a different year", () => {
    expect(countryRowsForYear({ year: 2019, rows: [{ country: "USA", FVA_share: 0.12 }] }, 2020)).toBeNull();
    expect(countryRowsForYear({ year: 2020, rows: [{ country: "USA", FVA_share: 0.12 }] }, 2020)).toEqual([
      { country: "USA", FVA_share: 0.12 },
    ]);
  });

  test("records the selected country alone for one year with complete provenance", () => {
    expect(indicatorMaterialPatch(
      [
        { country: "CHN", FVA_share: 0.22 },
        { country: "USA", FVA_share: 0.14 },
      ],
      "CHN",
      2020,
      "FVA_share",
      "比例",
      "release-1",
    )).toEqual({
      year: 2020,
      country: "CHN",
      metric: "FVA_share",
      compared: ["CHN"],
      observations: [
        {
          entity: "CHN", country: "CHN", industry: "", year: 2020, value: 0.22,
          metric: "FVA_share", unit: "比例", release: "release-1", scope: "country",
          source: "auto-indicator-comparison",
        },
      ],
    });
  });

  test("records nothing without a country, a release or a finite reading", () => {
    const rows = [{ country: "CHN", FVA_share: 0.22 }, { country: "USA", FVA_share: null }];
    expect(indicatorMaterialPatch(rows, "USA", 2019, "FVA_share", "比例", "release-1")).toBeNull();
    expect(indicatorMaterialPatch(rows, "JPN", 2019, "FVA_share", "比例", "release-1")).toBeNull();
    expect(indicatorMaterialPatch(rows, "", 2019, "FVA_share", "比例", "release-1")).toBeNull();
    expect(indicatorMaterialPatch(rows, "CHN", 2019, "FVA_share", "比例", "")).toBeNull();
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
    const expanded = indicatorMetricColumns("production", fields, row, true);
    const core = indicatorMetricColumns("production", fields, row);
    expect([...expanded].sort()).toEqual([...fields].sort());
    // The core columns keep their places; the extra ones follow.
    expect(expanded.slice(0, core.length)).toEqual(core);
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

test("加权总度、入度、出度 share one precision per row so the identity reads from the shown values", () => {
  const schema = { groups: [], fields: { "weighted degree": { format: "amount" }, "weighted indegree": { format: "amount" }, "weighted outdegree": { format: "amount" } } } as never;
  const small = { "weighted degree": 1.407, "weighted indegree": 0.715, "weighted outdegree": 0.692 };
  expect(["weighted degree", "weighted indegree", "weighted outdegree"].map((key) => fmtIndicatorCell(small, key, schema))).toEqual(["1.407", "0.715", "0.692"]);
  // One of three under 10: all three keep 3 decimals.
  expect(fmtIndicatorCell({ "weighted degree": 12.4, "weighted indegree": 11.7, "weighted outdegree": 0.7 }, "weighted degree", schema)).toBe("12.400");
  const large = { "weighted degree": 5321.6, "weighted indegree": 2000.2, "weighted outdegree": 3321.4 };
  expect(fmtIndicatorCell(large, "weighted degree", schema)).toBe("5,322");
  // An exact 0 stays 0 and does not force decimals onto the others.
  expect(fmtIndicatorCell({ "weighted degree": 30, "weighted indegree": 0, "weighted outdegree": 30 }, "weighted outdegree", schema)).toBe("30");
  expect(fmtIndicatorCell({ "weighted degree": 30, "weighted indegree": 0, "weighted outdegree": 30 }, "weighted indegree", schema)).toBe("0");
});
