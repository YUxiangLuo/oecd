import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import { countryObservation, countryRowsForYear, restoreIndicatorSelection } from "./indicator-table";

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
