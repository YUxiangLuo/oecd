import { describe, expect, test } from "bun:test";
import { oecdIcioDatasetLabel, oecdIcioEdition } from "./dataset-label";
import type { Meta } from "./types";

describe("OECD ICIO release label", () => {
  test("keeps database vintage separate from data coverage years", () => {
    const meta = {
      years: [2016, 2017, 2018, 2019, 2020],
      countries: [],
      sectors: [],
      dataset: { years: [2016, 2017, 2018, 2019, 2020], data_sources: { oecd_icio: { release: "2023" } } },
    } as Meta;
    expect(oecdIcioEdition(meta)).toBe("2023");
    expect(oecdIcioDatasetLabel(meta)).toBe("OECD ICIO 2023 版 · 数据期 2016–2020");
  });
});
