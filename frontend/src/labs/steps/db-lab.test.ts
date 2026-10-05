import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DbMeta, DbSlice, Meta } from "../../types";
import { fmtDb } from "../shared";
import {
  captureDbObservation,
  codePlainName,
  dbCellAccessibleName,
  dbCellTooltip,
  dbObservationSentence,
  dbColumnCountryForTable,
  DbSliceTable,
  finiteDbCells,
  formatYColumnHeader,
  isCapturedDbCell,
  moveDbCell,
  normalizeDbActiveCell,
  observationSourceLabel,
  ReleaseIntegrityStatus,
  restoreDbSlice,
  sliceAutosave,
  STEP1_ACCOUNT_LEGEND,
  STEP1_OUT_IDENTITY_GUIDE,
} from "./db-lab";

test("Step 1 shows a compact automatic integrity status without student action", () => {
  const releaseMeta: Meta = {
    years: [2020], countries: ["CHN"], sectors: ["D01T02"],
    dataset: {
      years: [2020],
      integrity: {
        status: "passed",
        scopes: {
          years: {}, outputs: {},
          controls: { passed: true, checked: [], failures: [] },
          shocks: { passed: true, checked: [], failures: [] },
          regression_inputs: { passed: true, checked: [], failures: [] },
        },
      },
    },
  };
  const html = renderToStaticMarkup(createElement(ReleaseIntegrityStatus, { meta: releaseMeta }));
  expect(html).toContain("数据已通过系统完整性检查");
  expect(html).toContain("无需你另外校验");
  expect(html).not.toContain("button");
  expect(renderToStaticMarkup(createElement(ReleaseIntegrityStatus, { meta: null }))).toBe("");
});

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
      observation: {
        row: "CHN_D01T02",
        column: "USA_D01T02",
        value: 228.0672,
        year: 2020,
        table: "z",
        row_country: "CHN",
        col_country: "USA",
        row_sector: "",
        col_sector: "",
      },
    });
  });

  test("browsing another slice does not rewrite the captured cell source", () => {
    const captured = captureDbObservation(
      {
        year: 2020,
        table: "z",
        rowCountry: "CHN",
        colCountry: "USA",
        rowSector: "",
        colSector: "",
      },
      { row: "CHN_D01T02", column: "USA_D01T02", value: 228.0672 },
    );
    const browsed = sliceAutosave({
      year: 2019,
      table: "y",
      rowCountry: "USA",
      colCountry: "CHN",
      rowSector: "",
      colSector: "",
    });
    expect(browsed.slice?.year).toBe(2019);
    expect(captured.observation?.year).toBe(2020);
    expect(captured.observation?.table).toBe("z");
    expect(captured.observation && observationSourceLabel(captured.observation)).toBe("2020 · 中间投入 Z");
  });

  test("does not mark the same row, column and value as captured in another year", () => {
    const captured = captureDbObservation(
      {
        year: 2020,
        table: "z",
        rowCountry: "ARG",
        colCountry: "ARG",
        rowSector: "A01_02",
        colSector: "B09",
      },
      { row: "ARG_A01_02", column: "ARG_B09", value: 0 },
    ).observation;

    expect(isCapturedDbCell(captured, {
      year: 2020, table: "z", row: "ARG_A01_02", column: "ARG_B09", value: 0,
    })).toBe(true);
    expect(isCapturedDbCell(captured, {
      year: 2019, table: "z", row: "ARG_A01_02", column: "ARG_B09", value: 0,
    })).toBe(false);
    expect(isCapturedDbCell(captured, {
      year: 2020, table: "accounts", row: "ARG_A01_02", column: "ARG_B09", value: 0,
    })).toBe(false);
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

  test("keeps signed accounts and both complete OUT identities explicit", () => {
    expect(STEP1_ACCOUNT_LEGEND).toContain("负 TLS 表示净补贴，不是缺失");
    expect(STEP1_ACCOUNT_LEGEND).toContain("负 INVNT 表示有符号的存货减少调整，不是缺失");
    expect(STEP1_ACCOUNT_LEGEND).toContain("VA = 增加值");
    expect(STEP1_ACCOUNT_LEGEND).toContain("OUT = 总产出");
    expect(STEP1_OUT_IDENTITY_GUIDE).toContain("按行 OUT = Z 行和 + Y 行和");
    expect(STEP1_OUT_IDENTITY_GUIDE).toContain("按列 OUT = Z 列和 + VA + TLS");
    expect(STEP1_OUT_IDENTITY_GUIDE).toContain("只是完整和的一部分");
  });

  test("formats tiny true values without displaying zero or negative zero", () => {
    expect(fmtDb(0.0001)).toBe("0.0001");
    expect(fmtDb(-0.0001)).toBe("-0.0001");
    expect(fmtDb(0.00001)).toBe("1e−5");
    expect(fmtDb(-0.00001)).toBe("-1e−5");
    expect(fmtDb(-0)).toBe("0");
  });
});

describe("Step 1 bounded roving cell focus", () => {
  const navigationRows: DbSlice["rows"] = [
    { row: "R0", C1: 1, C2: null, C3: 3 },
    { row: "R1", C1: null, C2: 2, C3: 4 },
    { row: "R2", C1: 5, C2: 6, C3: null },
  ];
  const navigationCells = finiteDbCells(navigationRows, ["row", "C1", "C2", "C3"]);

  test("keeps one page-local active cell and normalizes stale scope keys", () => {
    expect(navigationCells.map((cell) => cell.key)).toEqual(["0:1", "0:3", "1:2", "1:3", "2:1", "2:2"]);
    expect(normalizeDbActiveCell(navigationCells, "stale", undefined)?.key).toBe("0:1");
    expect(normalizeDbActiveCell(navigationCells, null, {
      row: "R1", column: "C3", value: 4, year: 2020, table: "z",
    })?.key).toBe("1:3");
    expect(normalizeDbActiveCell([], "0:1", undefined)).toBeNull();
  });

  test("moves by row/column, skips nulls, clamps, and never wraps horizontally", () => {
    expect(moveDbCell(navigationCells, "0:1", "ArrowRight")?.key).toBe("0:3");
    expect(moveDbCell(navigationCells, "0:3", "ArrowRight")?.key).toBe("0:3");
    expect(moveDbCell(navigationCells, "0:1", "ArrowLeft")?.key).toBe("0:1");
    expect(moveDbCell(navigationCells, "0:1", "ArrowDown")?.key).toBe("2:1");
    expect(moveDbCell(navigationCells, "2:2", "ArrowUp")?.key).toBe("1:2");
    expect(moveDbCell(navigationCells, "0:3", "ArrowDown")?.key).toBe("1:3");
    expect(moveDbCell(navigationCells, "1:3", "ArrowDown")?.key).toBe("1:3");
  });

  test("supports row and page Home/End boundaries", () => {
    expect(moveDbCell(navigationCells, "1:3", "Home")?.key).toBe("1:2");
    expect(moveDbCell(navigationCells, "1:2", "End")?.key).toBe("1:3");
    expect(moveDbCell(navigationCells, "1:2", "Home", true)?.key).toBe("0:1");
    expect(moveDbCell(navigationCells, "1:2", "End", true)?.key).toBe("2:2");
  });

  test("renders 1,125 finite buttons with exactly one sequential cell stop", () => {
    const columns = ["row", ...Array.from({ length: 45 }, (_, index) => `C${index + 1}`)];
    const rows = Array.from({ length: 25 }, (_, rowIndex) => Object.fromEntries([
      ["row", `R${rowIndex + 1}`],
      ...columns.slice(1).map((column, columnIndex) => [column, rowIndex * 45 + columnIndex]),
    ]));
    const slice: DbSlice = {
      year: 2020, table: "z", total: 25, page: 1, page_size: 25,
      columns, rows, row_summaries: [],
    };
    const html = renderToStaticMarkup(createElement(DbSliceTable, {
      slice,
      table: "z",
      focusScopeKey: "2020-z-page1",
      selection: {
        year: 2020, table: "z", rowCountry: "CHN", colCountry: "USA", rowSector: "", colSector: "",
      },
      onCapture: () => {},
    }));

    expect(html.match(/class="db-observation-cell/g)).toHaveLength(1125);
    expect(html.match(/class="db-observation-cell[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/class="db-observation-cell[^>]*tabindex="-1"/g)).toHaveLength(1124);
    expect(html).toContain('role="region" tabindex="-1"');
    // 界面不展示任何键盘操作说明（caption 只保留表名与单位）
    const caption = html.match(/<caption>([^<]*)<\/caption>/)?.[1] ?? "";
    expect(caption).toContain("单位：百万美元");
    expect(caption).not.toMatch(/Tab|方向键|Enter|空格/);
    expect(html).toContain('<th scope="row"');
    expect(html).toContain("R1(行·供给方) → C1(列·使用方)，值 0 百万美元，未记录");
    expect(html).not.toContain("按 Enter");
  });

  test("uses the named region as the sole stop for an all-null page and labels recorded state", () => {
    const slice: DbSlice = {
      year: 2020, table: "y", total: 1, page: 1, page_size: 25,
      columns: ["row", "USA_HFCE"], rows: [{ row: "CHN_A01_02", USA_HFCE: null }], row_summaries: [],
    };
    const html = renderToStaticMarkup(createElement(DbSliceTable, {
      slice,
      table: "y",
      focusScopeKey: "empty",
      selection: {
        year: 2020, table: "y", rowCountry: "CHN", colCountry: "USA", rowSector: "", colSector: "",
      },
      onCapture: () => {},
    }));
    expect(html).not.toContain("db-observation-cell");
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('role="region" tabindex="0"');
    expect(dbCellAccessibleName("y", { row: "CHN_A01_02", column: "USA_HFCE", value: 2.5 }, true))
      .toContain("USA 居民最终消费支出(列·最终需求)，值 2.5 百万美元，已记录");
  });

  test("observation sentence states the supply direction in one full reading", () => {
    expect(dbObservationSentence("z", "CHN_A01_02", "USA_C10T12"))
      .toBe("CHN 中国·A01_02(行·供给方) → USA 美国·C10T12(列·使用方)");
    expect(dbObservationSentence("y", "CHN_A01_02", "USA_HFCE"))
      .toBe("CHN 中国·A01_02(行·供给方) → USA 居民最终消费支出(列·最终需求)");
    expect(dbObservationSentence("accounts", "CHN_A01_02", "VA")).toBe("CHN_A01_02 的 VA");
  });
});

test("Step 1 cell tooltips name both industries in two short lines", () => {
  expect(dbCellTooltip("z", "CHN_C10T12", "USA_C10T12", 742.09))
    .toBe("中国 · C10T12 食品饮料烟草 → 美国 · C10T12 食品饮料烟草\n742.09 百万美元 · 点击记录这个观察值");
  expect(dbCellTooltip("y", "CHN_A01_02", "USA_INVNT", -1.5).split("\n")[0])
    .toBe("中国 · A01_02 农林牧业 → 美国 · 存货变化（有符号调整）");
  expect(dbCellTooltip("accounts", "CHN_A01_02", "VA", 12.5).split("\n")[0])
    .toBe("中国 · A01_02 农林牧业 的 增加值");
});

test("Step 1 header plain names never repeat a code that has no name", () => {
  expect(codePlainName("USA_C10T12")).toBe("食品饮料烟草");
  expect(codePlainName("TLS")).toBe("产品税减补贴");
  expect(codePlainName("USA_X99")).toBeUndefined();
  expect(codePlainName("X99")).toBeUndefined();
});
