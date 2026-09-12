import { describe, expect, test } from "bun:test";
import { icioDatasetName, oecdIcioDatasetLabel, oecdIcioEdition } from "./dataset-label";
import type { Meta } from "./types";

describe("OECD ICIO release label", () => {
  test("labels synthetic releases and never assumes missing provenance is OECD data", () => {
    const meta = {
      years: [2016, 2020], countries: [], sectors: [],
      dataset: { years: [2016, 2020], data_sources: { ci_synthetic_icio: { production_data: false } } },
    } as Meta;
    expect(oecdIcioDatasetLabel(meta)).toBe("模拟投入产出数据（教学用） · 数据期 2016–2020");
    expect(icioDatasetName(null)).toBe("投入产出数据（来源待确认）");
    expect(icioDatasetName({ ...meta, dataset: null })).toBe("投入产出数据（来源待确认）");
    expect(icioDatasetName({ ...meta, dataset: { ...meta.dataset!, data_sources: {} } })).toBe("投入产出数据（来源待确认）");
  });

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
