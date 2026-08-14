import { describe, expect, test } from "bun:test";
import type { DbMeta } from "../../types";
import { captureDbObservation, dbColumnCountryForTable, formatYColumnHeader, restoreDbSlice, sliceAutosave } from "./step1-db";

const meta: DbMeta = {
  years: [2019, 2020],
  default_year: 2020,
  countries: ["CHN", "USA"],
  sectors: ["D01T02", "D10T12"],
  final_demand_categories: ["HFCE", "GFCF"],
  account_rows: ["TLS", "VA", "OUT"],
  files: [],
  n_rows: 0,
  n_columns: 0,
};

describe("database slice restoration", () => {
  test("restores a valid final-demand slice", () => {
    expect(restoreDbSlice(meta, {
      year: 2019,
      table: "y",
      row_country: "CHN",
      col_country: "USA",
      row_sector: "D01T02",
      col_sector: "HFCE",
    })).toEqual({
      year: 2019,
      table: "y",
      rowCountry: "CHN",
      colCountry: "USA",
      rowSector: "D01T02",
      colSector: "HFCE",
    });
  });

  test("rejects a slice that does not belong to the active artifact", () => {
    expect(restoreDbSlice(meta, {
      year: 2018,
      table: "z",
      row_country: "CHN",
      col_country: "USA",
    })).toBeNull();
  });

  test("capturing a cell also records the default slice that gave it meaning", () => {
    expect(captureDbObservation(
      {
        year: 2020,
        table: "z",
        rowCountry: "CHN",
        colCountry: "USA",
        rowSector: "",
        colSector: "",
      },
      { row: "CHN_D01T02", column: "USA_D01T02", value: 228.0672 },
    )).toEqual({
      slice: {
        year: 2020,
        table: "z",
        row_country: "CHN",
        col_country: "USA",
        row_sector: "",
        col_sector: "",
      },
      observation: { row: "CHN_D01T02", column: "USA_D01T02", value: 228.0672 },
    });
  });

  test("restores a real column country when leaving an accounts-only slice", () => {
    expect(dbColumnCountryForTable(meta, "", "z")).toBe("USA");
    expect(dbColumnCountryForTable(meta, "CHN", "y")).toBe("CHN");
    expect(dbColumnCountryForTable(meta, "", "accounts")).toBe("");
  });

  test("slice autosave does not clear a recorded observation", () => {
    const patch = sliceAutosave({
      year: 2020,
      table: "y",
      rowCountry: "CHN",
      colCountry: "USA",
      rowSector: "",
      colSector: "",
    });
    expect(patch).toEqual({
      slice: {
        year: 2020,
        table: "y",
        row_country: "CHN",
        col_country: "USA",
        row_sector: "",
        col_sector: "",
      },
    });
    expect(patch).not.toHaveProperty("observation");
  });

  test("Y column headers show the demand category in Chinese", () => {
    expect(formatYColumnHeader("USA_HFCE")).toBe("USA 居民最终消费支出");
    expect(formatYColumnHeader("CHN_GFCF")).toBe("CHN 固定资本形成总额(投资)");
    expect(formatYColumnHeader("USA_A01_02")).toBe("USA_A01_02");
    expect(formatYColumnHeader("row")).toBe("row");
  });
});
