import { describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import { restoreVizState, type VizStepState } from "./scaffold";
import { compositionSegmentColor, NEGATIVE_COMPOSITION_STYLE } from "../../../viz/explore/charts";
import { CAT } from "../../../viz/shared";
import { eligibleExportCompositionRows, TradeVizStep, TRADE_DEFAULT_LENS, TRADE_LENSES, WWZ_READING_GUIDE, WWZ_SEGMENTS } from "./trade";

const meta: Meta = {
  years: [2020], countries: ["CHN", "USA"], sectors: ["A"],
  dataset: { years: [2020], release_id: "a".repeat(32) },
};

test("new trade sessions start with the whole export, but saved lenses are preserved", () => {
  expect(restoreVizState(meta, undefined, TRADE_DEFAULT_LENS, TRADE_LENSES).lens).toBe("decompose");
  for (const chart of TRADE_LENSES) {
    expect(restoreVizState(meta, { chart }, TRADE_DEFAULT_LENS, TRADE_LENSES).lens).toBe(chart);
  }
});

test("trade views use plain bounded labels and disclose representative-only report capture", async () => {
  const rows = meta.countries.map((country, i) => ({
    country, gross_exports: 100, DVAex: 60 - 10 * i, DVArt: 10, DDC: 5,
    FVA: 20 + 10 * i, FDC: 3, taxsub: 2, FVA_share: 0.2 + 0.1 * i, "3_VA_GVC_share": 0.4 + 0.1 * i,
  }));
  const request = spyOn(api, "countryIndicators").mockResolvedValue(rows);
  const schema = spyOn(api, "indicatorSchema").mockResolvedValue({ groups: [], fields: {} });
  const state: StepStateApi<VizStepState> = {
    data: { compared: ["CHN", "USA"] }, save: () => {}, complete: false,
    syncing: false, syncError: null, syncNow: () => {},
  };
  try {
    const view = render(createElement(TradeVizStep, { meta, step: { n: 6 } as Step, state }));
    await view.findByRole("heading", { name: "拆开一国的出口：各项价值从哪里来？" });
    expect(view.getByRole("button", { name: "出口拆解" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.container.textContent).toContain("不保存图表全部分项");
    fireEvent.click(view.getByRole("button", { name: "定位图" }));
    expect(view.getByText("两项占比均较高")).toBeTruthy();
    expect(view.container.textContent).not.toContain("深度嵌入");
    expect(view.container.textContent).not.toContain("进口依赖");
    fireEvent.click(view.getByRole("button", { name: "占比排名" }));
    expect(view.getByRole("heading", { name: "外国增加值项占比排名" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("EXGR_FVASH");
    expect(view.container.textContent).not.toContain("课程 FVA");
  } finally { cleanup(); request.mockRestore(); schema.mockRestore(); }
});

describe("step 6 export decomposition provenance copy", () => {
  test("binds every legend segment to the correct provenance and palette slot", () => {
    expect(WWZ_SEGMENTS.map(({ key, provenance }) => [key, provenance])).toEqual([
      ["DVAex", "domestic"],
      ["DVArt", "domestic"],
      ["DDC", "domestic"],
      ["FVA", "foreign"],
      ["FDC", "foreign"],
      ["taxsub", "extension"],
    ]);
    expect(WWZ_SEGMENTS.map(({ color }) => color)).toEqual(CAT);
  });

  test("derives the reading instruction from every adjacent legend entry", () => {
    for (const segment of WWZ_SEGMENTS) {
      expect(WWZ_READING_GUIDE).toContain(`${segment.colorName} ${segment.key}`);
    }
    expect(WWZ_READING_GUIDE).toContain("正值时");
    expect(WWZ_READING_GUIDE).toContain("属于国内增加值及其重复计算");
    expect(WWZ_READING_GUIDE).toContain("属于外国增加值及其重复计算");
    expect(WWZ_READING_GUIDE).toContain("是 OECD TLS 账户扩展");
  });

  test("requires the authoritative gross-export total and every rendered segment", () => {
    const complete = Object.fromEntries([
      ["country", "OK"],
      ["gross_exports", 21],
      ...WWZ_SEGMENTS.map((segment, index) => [segment.key, index - 2]),
    ]);
    for (const required of ["gross_exports", ...WWZ_SEGMENTS.map((segment) => segment.key)]) {
      const invalid = { ...complete, [required]: null };
      expect(eligibleExportCompositionRows([complete, invalid]).map((row) => row.country)).toEqual(["OK"]);
    }
  });

  test("uses and explains the shared red negative override without changing provenance", () => {
    for (const [index, segment] of WWZ_SEGMENTS.entries()) {
      expect(compositionSegmentColor(segment, index, false)).toBe(segment.color);
      expect(compositionSegmentColor(segment, index, true)).toBe(NEGATIVE_COMPOSITION_STYLE.color);
    }
    expect(WWZ_READING_GUIDE).toContain(`负分项统一以${NEGATIVE_COMPOSITION_STYLE.colorName}显示在零轴左侧`);
    expect(WWZ_READING_GUIDE).toContain("不改变其国内、外国或 TLS 扩展归类");
  });
});
