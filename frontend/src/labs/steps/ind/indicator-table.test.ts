import { describe, expect, test } from "bun:test";
import type { Meta } from "../../../types";
import {
  defaultIndicatorMetrics,
  indicatorColumnLabel,
  restoreIndicatorSelection,
} from "./indicator-table";

const meta = {
  years: [2018, 2019, 2020],
  countries: ["CHN", "USA", "JPN"],
} as Meta;

describe("indicator table teaching defaults", () => {
  test("shows student labels for stable base fields", () => {
    expect(["country", "industry", "year"].map((key) => indicatorColumnLabel(key)))
      .toEqual(["经济体", "行业", "年份"]);
  });

  test("keeps each step's defining metric in the default five columns", () => {
    expect(defaultIndicatorMetrics("trade", [
      "gross_exports", "DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub", "EXDVA", "FVA_share", "DVAex_share",
    ])).toEqual(["gross_exports", "DVAex", "FVA", "FVA_share", "DVAex_share"]);
    expect(defaultIndicatorMetrics("production", [
      "SVA", "1_VA_D", "2_VA_RT", "3_VA_GVC", "3a_VA_GVC_S", "3b_VA_GVC_C", "3b_VA_GVC_C_share",
    ])).toContain("3b_VA_GVC_C_share");
    expect(defaultIndicatorMetrics("length", ["PLv", "PLv_D", "PLv_GVC", "PLy", "PLy_GVC", "GVCPs"]))
      .toContain("GVCPs");
    expect(defaultIndicatorMetrics("network", ["degree", "indegree", "weighted degree", "weighted indegree", "weighted outdegree", "betweenesscentrality"]))
      .toContain("betweenesscentrality");
  });
});

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
