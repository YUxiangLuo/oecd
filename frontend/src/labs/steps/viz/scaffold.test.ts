import { describe, expect, test } from "bun:test";
import { addInspectedCountry, persistableVizYear, restoreVizState } from "./scaffold";

const meta = { years: [2018, 2019, 2020], countries: ["CHN", "SGP", "USA"] };

describe("restoreVizState", () => {
  test("restores saved lens, year and picked countries", () => {
    expect(restoreVizState(meta, {
      chart: "industry",
      year: 2019,
      compared: ["SGP", "USA"],
    }, "ladder", ["ladder", "rank", "industry"])).toEqual({
      year: 2019,
      lens: "industry",
      picked: ["SGP", "USA"],
    });
  });

  test("refuses a year the current release does not contain", () => {
    expect(persistableVizYear(meta.years, 0)).toBe(2020);
    expect(persistableVizYear(meta.years, Number.NaN)).toBe(2020);
    expect(persistableVizYear(meta.years, 2019)).toBe(2019);
    expect(restoreVizState(meta, { year: 0, chart: "ladder" }, "ladder", ["ladder"]).year).toBe(2020);
  });

  test("records a newly inspected country without dropping earlier ones", () => {
    expect(addInspectedCountry(["CHN"], "USA", meta.countries)).toEqual(["CHN", "USA"]);
    expect(addInspectedCountry(["CHN"], "CHN", meta.countries)).toEqual(["CHN"]);
    expect(addInspectedCountry(["CHN"], "XXX", meta.countries)).toEqual(["CHN"]);
  });

  test("drops values that do not belong to the current dataset metadata", () => {
    expect(restoreVizState(meta, {
      chart: "removed-lens",
      year: 2016,
      compared: ["CHN", "XXX"],
    }, "ladder", ["ladder", "rank", "industry"])).toEqual({
      year: 2020,
      lens: "ladder",
      picked: ["CHN"],
    });
  });
});
