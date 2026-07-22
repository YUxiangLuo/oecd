import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import { restoreIndicatorSelection } from "./indicator-table";

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
});
