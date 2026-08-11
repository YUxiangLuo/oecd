import { describe, expect, test } from "bun:test";
import { restoreVizState } from "./scaffold";

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
