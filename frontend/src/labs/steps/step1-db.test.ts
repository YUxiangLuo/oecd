import { describe, expect, test } from "bun:test";
import type { DbMeta } from "../../types";
import { captureDbObservation, restoreDbSlice } from "./step1-db";

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
});
