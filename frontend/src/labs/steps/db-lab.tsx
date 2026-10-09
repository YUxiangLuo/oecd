import { useEffect, useRef, useState } from "react";
import { sameJsonValue } from "../../session-store";
import { MATERIAL_LOCKED_NOTE, MATERIAL_RECHOSEN_NEXT } from "../../step-task-card";
import { LabeledControl, ScrollableRegion } from "../../a11y";
import { api } from "../../api";
import { icioDatasetName } from "../../dataset-label";
import { FullscreenPanel, FullscreenTriggerSlot } from "../../fullscreen-panel";
import { ColumnInfo, useMeasuredWidth } from "../../table-aids";
import type { DbMeta, DbSlice, DbTableKind, Meta, QuizCompletionState, StepStateApi } from "../../types";
import { userFacingRequestError } from "../../user-facing-error";
import { countryLabel, sectorLabel } from "../../viz";
import { cjkJoin } from "../../format";
import { fmtDb, Pager, useAsync } from "../shared";

/** `detail` is shown on the tab only; `label` also names the table in titles and the recorded source. */
const DB_TABLES: { key: DbTableKind; label: string; detail?: string }[] = [
  { key: "z", label: "中间投入 Z" },
  { key: "y", label: "最终需求 Y" },
  { key: "accounts", label: "账户项", detail: "税 / 增加值 / 总产出" },
];

/** 首列表头。后端返回的列名就是字面的 "row",直接显示对学生没有信息量。 */
const ROW_HEADER: Record<DbTableKind, { label: string; title: string }> = {
  z: { label: "供给国×行业（行）", title: "每一行是提供中间投入的一方：某国某行业" },
  y: { label: "供给国×行业（行）", title: "每一行是提供最终产品的一方：某国某行业" },
  accounts: { label: "国家×行业（行）", title: "每一行是一个国家×行业；列为该行业的账户项" },
};

/** 角标:行/列两个方向就地写全,代替容易被贴错轴的单一句子。
 *  渲染顺序与空间邻近一致:列说明在上(与列轴横跨带同排),行说明在下(贴近行头区)。 */
const AXIS_CORNER: Record<DbTableKind, { row: string; col: string }> = {
  z: { row: "行·供给方 ↓", col: "列·使用方 →" },
  y: { row: "行·供给方 ↓", col: "列·最终需求 →" },
  accounts: { row: "行·国家×行业 ↓", col: "列·账户项 →" },
};

/** 列数据区上方的横跨带:角色 + 方向 + 当前选中的列国家,让列轴自我声明。 */
function columnAxisBand(table: DbTableKind, colCountry: string): string {
  const country = colCountry ? countryLabel(colCountry) : "";
  if (table === "z") return `使用国×行业（列）→ ${country}`;
  if (table === "y") return `需求国×需求类别（列）→ ${country}`;
  return "账户项（列）";
}

/** 表格怎么读:行是供给方、列是使用方——这是投入产出表最容易被看反的一点,
 *  因为"行"虽然横向延伸,它的标签却竖排在最左侧。读法一律锚定标签的视觉位置
 *  (左侧竖排/上方横排),不再依赖"行/列"抽象词的二次换算。 */
const HOW_TO_READ: Record<DbTableKind, string> = {
  z: "每个数值表示左侧这一行（供给国×行业）向上方这一列（使用国×行业）提供的中间投入。最左边一列的标签是行名：每个标签对应它右边的一整行。单位：百万美元。",
  y: "每个数值表示左侧这一行（供给国×行业）的产品被上方这一列（需求国×需求类别）最终使用的金额。最左边一列的标签是行名：每个标签对应它右边的一整行。单位：百万美元。",
  accounts: "每一行是一个国家×行业，列是该行业的账户项（TLS / VA / OUT）；这张表的列没有国家之分。单位：百万美元。",
};

const ACCOUNT_HELP: Record<string, string> = {
  TLS: "产品税减补贴。为负表示净补贴；步骤 2 的 taxsub 是出口中直接和间接包含的这部分产品税减补贴。",
  VA: "增加值：劳动报酬、资本回报等本地创造的价值，是步骤 3 的生产活动分解的总来源。",
  OUT: "总产出。两个等式：按行 OUT = Z 行和 + Y 行和；按列 OUT = Z 列和 + VA + TLS。系统已自动核对这两个等式。",
};

/** OECD ICIO 最终需求类别缩写 → 中文名(Y 表列名形如 USA_HFCE:目的国_需求类别) */
export const STEP1_ACCOUNT_LEGEND = "TLS = 产品税减补贴（负 TLS 表示净补贴，不是缺失）；VA = 增加值；OUT = 总产出；INVNT = 存货变化（负 INVNT 表示存货减少，不是缺数据）。";
export const STEP1_OUT_IDENTITY_GUIDE = "按行 OUT = Z 行和 + Y 行和；按列 OUT = Z 列和 + VA + TLS。本页只显示部分国家和行业，所以这里的合计小于 OUT；差额来自没有显示的国家、行业或需求类别。";

const FD_HELP: Record<string, string> = {
  HFCE: "居民最终消费支出",
  NPISH: "为居民服务的非营利机构消费",
  GGFC: "政府最终消费支出",
  GFCF: "固定资本形成总额（投资）",
  INVNT: "存货变化；为负表示存货减少，不是缺数据",
  DPABR: "居民境外直接购买（出境旅行等消费）",
};
const ACCOUNT_SHORT: Record<string, string> = { TLS: "产品税减补贴", VA: "增加值", OUT: "总产出" };
/** Short names for headers, options and recorded sentences; the full help stays in the tooltip. */
const FD_NAMES: Record<string, string> = { ...FD_HELP, INVNT: "存货变化" };

/** 列头悬停说明:账户项直接查表;Y 表列拆成「目的国 + 需求类别」组合解释 */
function columnHelp(column: string): string | undefined {
  if (ACCOUNT_HELP[column]) return ACCOUNT_HELP[column];
  const sep = column.lastIndexOf("_");
  if (sep <= 0) return undefined;
  const category = FD_HELP[column.slice(sep + 1)];
  return category ? `${countryLabel(column.slice(0, sep))} 的${category}` : undefined;
}

/** 主流全球投入产出 / 多区域投入产出(MRIO)数据库速览。覆盖数字随各库版本更新、
 *  且行业/产品分类口径不同,不能直接横向相减;这里给学生一个"还有哪些选择"的地图。 */
const OTHER_DATABASES: { name: string; org: string; coverage: string; focus: string }[] = [
  { name: "WIOD（2016 年版）", org: "格罗宁根大学", coverage: "43 国 + ROW · 56 行业 · 2000–2014", focus: "含社会经济与环境数据" },
  { name: "Eora26", org: "悉尼大学", coverage: "约 190 经济体 · 26 行业", focus: "覆盖经济体多，附环境数据；具体年份和地区数以所下载的版本为准" },
  { name: "EXIOBASE 3", org: "多机构联合", coverage: "约 49 区域 · 约 200 产品", focus: "环境数据较细；具体覆盖以所下载的版本为准" },
  { name: "ADB MRIO", org: "亚洲开发银行", coverage: "60+ 经济体 · 35 行业", focus: "侧重亚太；具体覆盖以所下载的版本为准" },
];

/** 区分数据库目录与当前载入来源，不能把合成表的覆盖范围归给 OECD。 */
export function DatabaseGuide({ meta, releaseMeta }: { meta: DbMeta; releaseMeta: Meta | null }) {
  const namedEconomies = meta.countries.includes("ROW") ? meta.countries.length - 1 : meta.countries.length;
  const icioCoverage = `${namedEconomies} 个经济体${meta.countries.includes("ROW") ? " + 世界其他地区（ROW）" : ""} · ${meta.sectors.length} 行业 · ${meta.years[0]}–${meta.years.at(-1)}`;
  return (
    <div className="db-guide">
      <h3 className="kicker">全球投入产出数据库一览</h3>
      <p style={{ maxWidth: 820 }}>
        研究全球价值链，需要一张“谁向谁供货”的<b>跨国投入产出表</b>。下表比较几个常用数据库（截至 2026 年 8 月的课程整理，不是实时目录），它们的覆盖范围、行业或产品分类和更新频率各不相同：
      </p>
      <ScrollableRegion className="table-wrap" label="全球投入产出数据库对比表，可横向滚动" style={{ marginTop: 10 }}>
        <table className="data-table db-guide-table">
          <thead>
            <tr><th>数据库</th><th>编制方</th><th>覆盖</th><th>侧重 / 特点</th></tr>
          </thead>
          <tbody>
            <tr className="db-guide-default">
              <td><b>OECD ICIO</b></td>
              <td>OECD</td>
              <td>见下方“当前载入”</td>
              <td>以各国国民账户为基础，适合分析增加值贸易和全球价值链。</td>
            </tr>
            {OTHER_DATABASES.map((db) => (
              <tr key={db.name}>
                <td>{db.name}</td>
                <td>{db.org}</td>
                <td>{db.coverage}</td>
                <td>{db.focus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableRegion>
      <p className="muted" style={{ maxWidth: 820, marginTop: 10 }}>
        当前载入：<b>{icioDatasetName(releaseMeta)}</b>，{icioCoverage}。上表介绍数据库类型，不替代当前数据的来源说明。各数据库的分类方式不同，覆盖数字不能直接横向比较。
      </p>
    </div>
  );
}

/** 步骤1:本地 OECD ICIO 原始表浏览 */
/** 自动保存学生主动查看过的切片与单元格，供恢复界面和生成报告。 */
export interface DbStepState extends QuizCompletionState, Record<string, unknown> {
  slice?: {
    year: number;
    table: string;
    row_country: string;
    col_country: string;
    row_sector?: string;
    col_sector?: string;
  };
  observation?: {
    row: string;
    column: string;
    value: number;
    year?: number;
    table?: string;
    row_country?: string;
    col_country?: string;
    row_sector?: string;
    col_sector?: string;
    /** True when the system recorded this cell by default; a student click replaces it. */
    auto?: boolean;
  };
}

export interface DbSliceSelection {
  year: number;
  table: DbTableKind;
  rowCountry: string;
  colCountry: string;
  rowSector: string;
  colSector: string;
}

export function dbSliceSnapshot(selection: DbSliceSelection): NonNullable<DbStepState["slice"]> {
  return {
    year: selection.year,
    table: selection.table,
    row_country: selection.rowCountry,
    col_country: selection.table === "accounts" ? "" : selection.colCountry,
    row_sector: selection.rowSector,
    col_sector: selection.table === "accounts" ? "" : selection.colSector,
  };
}

export function captureDbObservation(
  selection: DbSliceSelection,
  observation: Pick<NonNullable<DbStepState["observation"]>, "row" | "column" | "value">,
): Pick<DbStepState, "slice" | "observation"> {
  const slice = dbSliceSnapshot(selection);
  return { slice, observation: { ...observation, ...slice } };
}

/** 换筛选只更新浏览位置；单元格自带记录时的切片，这里不得改写或清空。 */
export function sliceAutosave(selection: DbSliceSelection): Pick<DbStepState, "slice"> {
  return { slice: dbSliceSnapshot(selection) };
}

export function observationSourceLabel(observation: NonNullable<DbStepState["observation"]>): string | null {
  if (observation.year == null || !observation.table) return null;
  const table = DB_TABLES.find((item) => item.key === observation.table)?.label ?? observation.table;
  return `${observation.year} · ${table}`;
}

export function isCapturedDbCell(
  observation: DbStepState["observation"],
  cell: { year: number | null; table: DbTableKind; row: string; column: string; value: number | null },
): boolean {
  return cell.year != null
    && cell.value != null
    && observation?.year === cell.year
    && observation.table === cell.table
    && observation.row === cell.row
    && observation.column === cell.column
    && observation.value === cell.value;
}

export function formatYColumnHeader(column: string): string {
  const sep = column.lastIndexOf("_");
  if (sep <= 0) return column;
  const name = FD_NAMES[column.slice(sep + 1)];
  return name ? `${column.slice(0, sep)} ${name}` : column;
}

/** A Y column in a sentence: the destination country by name, e.g. "USA 美国·存货变化". */
export function yColumnSentenceLabel(column: string): string {
  const sep = column.lastIndexOf("_");
  if (sep <= 0) return column;
  const name = FD_NAMES[column.slice(sep + 1)];
  return name ? `${countryLabel(column.slice(0, sep))}·${name}` : column;
}

export function restoreDbSlice(meta: DbMeta, saved?: DbStepState["slice"]) {
  if (!saved || !meta.years.includes(saved.year)) return null;
  const table = DB_TABLES.some((item) => item.key === saved.table)
    ? saved.table as DbTableKind
    : null;
  if (!table || !meta.countries.includes(saved.row_country)) return null;
  if (table !== "accounts" && !meta.countries.includes(saved.col_country)) return null;
  const rowSector = saved.row_sector ?? "";
  if (rowSector && !meta.sectors.includes(rowSector)) return null;
  const colSector = saved.col_sector ?? "";
  const allowedColumns = table === "y" ? meta.final_demand_categories : meta.sectors;
  if (table !== "accounts" && colSector && !allowedColumns.includes(colSector)) return null;
  return {
    year: saved.year,
    table,
    rowCountry: saved.row_country,
    colCountry: table === "accounts" ? "" : saved.col_country,
    rowSector,
    colSector: table === "accounts" ? "" : colSector,
  };
}

/** 账户项不使用列国家；从已恢复的账户切片切回 Z/Y 时补回一个真实受控值。 */
export function dbColumnCountryForTable(meta: DbMeta, current: string, nextTable: DbTableKind): string {
  if (nextTable === "accounts" || meta.countries.includes(current)) return current;
  return meta.countries.includes("USA") ? "USA" : meta.countries[0] ?? "";
}

export interface DbCellCoordinate {
  key: string;
  rowIndex: number;
  columnIndex: number;
  row: string;
  column: string;
  value: number;
}

const dbCellKey = (rowIndex: number, columnIndex: number) => `${rowIndex}:${columnIndex}`;

/** Page-local finite cells in visual row/column order. */
/** The default cell recorded without a click: the largest positive flow in the loaded slice. */
export function defaultDbCell(slice: Pick<DbSlice, "rows" | "columns">): DbCellCoordinate | null {
  return finiteDbCells(slice.rows, slice.columns)
    .filter((cell) => cell.value > 0)
    .reduce<DbCellCoordinate | null>((best, cell) => (best == null || cell.value > best.value ? cell : best), null);
}

export function finiteDbCells(
  rows: DbSlice["rows"],
  columns: string[],
): DbCellCoordinate[] {
  const cells: DbCellCoordinate[] = [];
  rows.forEach((row, rowIndex) => {
    columns.forEach((column, columnIndex) => {
      const value = row[column];
      if (column === "row" || typeof value !== "number" || !Number.isFinite(value)) return;
      cells.push({
        key: dbCellKey(rowIndex, columnIndex),
        rowIndex,
        columnIndex,
        row: String(row.row ?? ""),
        column,
        value,
      });
    });
  });
  return cells;
}

export function normalizeDbActiveCell(
  cells: DbCellCoordinate[],
  requestedKey: string | null,
  captured?: DbStepState["observation"],
): DbCellCoordinate | null {
  const requested = requestedKey ? cells.find((cell) => cell.key === requestedKey) : undefined;
  if (requested) return requested;
  const recorded = captured && cells.find((cell) => (
    cell.row === captured.row
    && cell.column === captured.column
    && cell.value === captured.value
  ));
  return recorded || cells[0] || null;
}

export type DbCellNavigationKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";
export const DB_CELL_NAVIGATION_KEYS: readonly string[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
const DB_PAGE_ROWS = 10;

/** Resolve one roving-focus movement without wrapping across row boundaries. */
export function moveDbCell(
  cells: DbCellCoordinate[],
  currentKey: string,
  key: DbCellNavigationKey,
  ctrlKey = false,
): DbCellCoordinate | null {
  const current = cells.find((cell) => cell.key === currentKey);
  if (!current) return cells[0] || null;
  if (ctrlKey && key === "Home") return cells[0] || current;
  if (ctrlKey && key === "End") return cells.at(-1) || current;

  if (key === "Home" || key === "End") {
    const row = cells.filter((cell) => cell.rowIndex === current.rowIndex);
    return (key === "Home" ? row[0] : row.at(-1)) || current;
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const row = cells.filter((cell) => cell.rowIndex === current.rowIndex);
    const index = row.findIndex((cell) => cell.key === current.key);
    return row[index + (key === "ArrowLeft" ? -1 : 1)] || current;
  }
  const up = key === "ArrowUp" || key === "PageUp";
  const candidates = cells.filter((cell) => (
    cell.columnIndex === current.columnIndex
    && (up ? cell.rowIndex < current.rowIndex : cell.rowIndex > current.rowIndex)
  ));
  if (key === "PageUp") return candidates.at(-DB_PAGE_ROWS) || candidates[0] || current;
  if (key === "PageDown") return candidates[DB_PAGE_ROWS - 1] || candidates.at(-1) || current;
  return (up ? candidates.at(-1) : candidates[0]) || current;
}

/** A recorded 0 is allowed as report material, but the student should know it records "no flow". */
export function zeroCellNote(table: DbTableKind): string {
  if (table === "accounts") return "所选单元格为 0（这个国家×行业的该账户项为 0）";
  if (table === "y") return "所选单元格为 0（这个国家×行业的产品没有被该需求类别最终使用）";
  return "所选单元格为 0（这两个国家×行业之间没有中间投入流量）";
}

export function dbCellAccessibleName(
  table: DbTableKind,
  cell: Pick<DbCellCoordinate, "row" | "column" | "value">,
  recorded: boolean,
): string {
  // Same reading as the recorded sentence (industry names, not bare codes such as "F", which read like
  // final demand), followed by the value and whether it is recorded.
  return `${dbObservationSentence(table, cell.row, cell.column)}，值 ${fmtDb(cell.value)} 百万美元，${recorded ? "已记录" : "未记录"}`;
}

/** 行/列代码("CHN_A01_02")拆成国家 + 余部,给方向句提供带中文名的可读标签。 */
function splitRowColumnCode(code: string): { country: string; rest: string } {
  const sep = code.indexOf("_");
  if (sep <= 0) return { country: "", rest: code };
  return { country: code.slice(0, sep), rest: code.slice(sep + 1) };
}

/** 行/列表头裸代码的悬停说明:国家中文名·行业中文名。 */
function rowColumnCodeHelp(code: string): string | undefined {
  const { country, rest } = splitRowColumnCode(code);
  if (!country || !rest) return undefined;
  return `${countryLabel(country)}·${sectorLabel(rest)}`;
}

/**
 * Plain-language name shown under a code header: "USA_C10T12" → "食品饮料烟草", "TLS" → "产品税减补贴".
 * Undefined when the sector has no name, so the header never repeats its own code.
 */
export function codePlainName(code: string): string | undefined {
  if (ACCOUNT_SHORT[code]) return ACCOUNT_SHORT[code];
  const { country, rest } = splitRowColumnCode(code);
  if (!country || !rest) return undefined;
  const name = sectorLabel(rest).replace(/^\S+\s+/, "");
  return name && name !== rest ? name : undefined;
}

/** 列表头悬停说明:Y 表需求类别与账户项查表,Z 表退回国家×行业中文名。 */
function columnHeaderHelp(column: string): string | undefined {
  return columnHelp(column) ?? rowColumnCodeHelp(column);
}


/** "CHN 中国" → "中国"; the code already appears in the table headers. */
function countryName(code: string): string {
  return countryLabel(code).replace(/^[A-Z0-9]{2,4}\s+/, "");
}

/** "CHN_C10T12" → "中国 · C10T12 食品饮料烟草" (keeps the code so it matches the headers). */
function nodeLabel(code: string): string {
  const { country, rest } = splitRowColumnCode(code);
  return country && rest ? `${countryName(country)} · ${sectorLabel(rest)}` : code;
}

/** Two-line hover text for a value cell: who → whom with industry names, then value and action. */
export function dbCellTooltip(table: DbTableKind, row: string, column: string, value: number, locked = false): string {
  let pair: string;
  if (table === "accounts") {
    pair = `${nodeLabel(row)} 的 ${ACCOUNT_SHORT[column] ?? column}`;
  } else if (table === "y") {
    const sep = column.lastIndexOf("_");
    const demand = sep > 0 ? FD_HELP[column.slice(sep + 1)]?.split("；")[0] : undefined;
    pair = `${nodeLabel(row)} → ${demand ? `${countryName(column.slice(0, sep))} · ${demand}` : column}`;
  } else {
    pair = `${nodeLabel(row)} → ${nodeLabel(column)}`;
  }
  // After the report is submitted a click only selects the cell, so the hint must not promise a record.
  return `${pair}\n${fmtDb(value)} 百万美元 · ${locked ? "点击选中这个单元格" : "点击记录这个单元格"}`;
}

/** 观察值方向句:把 "A × B = v" 改写成 "A(行·供给方) → B(列·使用方) = v" 的完整读法,
 *  让学生在记录现场就地校验行列方向。 */
export function dbObservationSentence(table: DbTableKind, row: string, column: string): string {
  // Industry names, not bare codes: "USA 美国·F" read like final demand (F) instead of construction.
  const rowLabel = rowColumnCodeHelp(row) ?? row;
  if (table === "accounts") return `${rowLabel} 的 ${column}${ACCOUNT_SHORT[column] ? `（${ACCOUNT_SHORT[column]}）` : ""}`;
  if (table === "y") {
    return `${rowLabel}（行·供给方） → ${yColumnSentenceLabel(column)}（列·最终需求）`;
  }
  const colLabel = rowColumnCodeHelp(column) ?? column;
  return `${rowLabel}（行·供给方） → ${colLabel}（列·使用方）`;
}

export function DbSliceTable({
  slice,
  table,
  focusScopeKey,
  selection,
  selectedObservation,
  pickedObservation,
  locked = false,
  onCapture,
}: {
  slice: DbSlice | null;
  table: DbTableKind;
  focusScopeKey: string;
  selection: DbSliceSelection;
  selectedObservation?: DbStepState["observation"];
  /** A cell clicked after the report was submitted: marked in the table, but not yet the recorded material. */
  pickedObservation?: DbStepState["observation"];
  /** The report is submitted: a click selects a cell instead of recording it. */
  locked?: boolean;
  onCapture: (patch: Pick<DbStepState, "slice" | "observation">) => void;
  /**
   * 只是文案开关：激活单元格是否还会进入全屏。账户项页签不提供全屏，因此不能向学生
   * 宣称它会展开。实际展开由父组件的 autoExpandSignal 控制。
   */
}) {
  const [roving, setRoving] = useState<{ scope: string; key: string } | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const columns = slice?.columns ?? [];
  const rows = slice?.rows ?? [];
  const cells = finiteDbCells(rows, columns);
  const requestedKey = roving?.scope === focusScopeKey ? roving.key : null;
  const capturedForSlice = selectedObservation
    && selectedObservation.year === slice?.year
    && selectedObservation.table === table
    ? selectedObservation
    : undefined;
  const activeCell = normalizeDbActiveCell(cells, requestedKey, capturedForSlice);
  const dataColumns = columns.filter((column) => column !== "row");
  const absValue = (row: (typeof rows)[number], column: string) => Math.abs(typeof row[column] === "number" ? row[column] : 0);
  // Shading compares cells within a row; a one-column slice has nothing to compare along the row, so its
  // cells are shaded against the column instead (otherwise every cell is its own row's maximum).
  const columnHeatMax = Math.max(...rows.flatMap((row) => dataColumns.map((column) => absValue(row, column))), 0);
  const rowHeatMax = rows.map((row) => (
    dataColumns.length < 2 ? columnHeatMax : Math.max(...dataColumns.map((column) => absValue(row, column)), 0)
  ));
  const columnTotals = Object.fromEntries(dataColumns.map((column) => [
    column,
    rows.reduce((sum, row) => sum + (typeof row[column] === "number" ? row[column] : 0), 0),
  ]));
  const showSummaries = table !== "accounts" && Boolean(slice?.row_summaries?.length);
  const activeTable = DB_TABLES.find((item) => item.key === table)!;
  const [measureCorner, cornerWidth] = useMeasuredWidth<HTMLTableCellElement>();

  const focusCell = (cell: DbCellCoordinate) => {
    setRoving({ scope: focusScopeKey, key: cell.key });
    const focus = () => {
      const button = buttonRefs.current.get(cell.key);
      button?.focus();
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else globalThis.setTimeout(focus, 0);
  };

  return (
    <ScrollableRegion
      className="table-wrap bounded-data-table"
      label={`${cjkJoin(activeTable.label, "数据表")}，可横向滚动`}
      focusable={activeCell == null}
    >
      <table className="data-table db-table">
        <caption>
          {`${cjkJoin(activeTable.label, "数据表")} · 单位：百万美元。`}
        </caption>
        <thead>
          <tr className="db-axis-row">
            <th
              ref={measureCorner}
              rowSpan={2}
              className="db-axis-corner"
              title={ROW_HEADER[table].title}
              aria-label={`${AXIS_CORNER[table].col}，${AXIS_CORNER[table].row}`}
              style={{ position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" }}
            >
              <span className="db-axis-corner-col">{AXIS_CORNER[table].col}</span>
              <span className="db-axis-corner-row">{AXIS_CORNER[table].row}</span>
            </th>
            <th scope="colgroup" colSpan={Math.max(dataColumns.length, 1)} className="db-axis-cols">
              {/* The label slides along with horizontal scrolling, just right of the sticky corner, so the
                  column axis stays named however far the table is scrolled. */}
              <span style={{ position: "sticky", left: cornerWidth + 10, display: "inline-block" }}>
                {columnAxisBand(table, selection.colCountry)}
              </span>
            </th>
            {showSummaries && (
              <th colSpan={2} className="db-axis-cols" scope="colgroup" title="本行在当前所选列上的合计，以及该行业的总产出（OUT）">
                本行合计对照
              </th>
            )}
          </tr>
          <tr>
            {dataColumns.map((column) => {
              const name = table === "y" ? formatYColumnHeader(column) : column;
              // A definition the header does not already show (final demand categories, account items) gets a
              // focusable ⓘ; a Z column's country and industry are already in the band and the code name.
              const info = columnHelp(column);
              return (
                <th
                  key={column}
                  scope="col"
                  title={info ? undefined : columnHeaderHelp(column)}
                  aria-label={table === "y" ? formatYColumnHeader(column) : (rowColumnCodeHelp(column) ?? (codePlainName(column) ? `${column} ${codePlainName(column)}` : column))}
                >
                  {name}
                  {info && <ColumnInfo label={name} text={info} />}
                  {table !== "y" && codePlainName(column) && <small className="db-code-name">{codePlainName(column)}</small>}
                </th>
              );
            })}
            {showSummaries && <th scope="col">所选列之和<ColumnInfo label="所选列之和" text={ROW_SUM_HELP} /></th>}
            {showSummaries && <th scope="col">该行总产出 OUT<ColumnInfo label="该行总产出 OUT" text={ACCOUNT_HELP.OUT} /></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row.row ?? "row"}-${rowIndex}`}>
              {columns.map((column, columnIndex) => {
                const value = row[column];
                const numericValue = typeof value === "number" && Number.isFinite(value) ? value : null;
                const rowLabel = String(row.row ?? "");
                if (column === "row") {
                  return (
                    <th
                      key={column}
                      scope="row"
                      title={rowColumnCodeHelp(rowLabel)}
                      style={{ position: "sticky", left: 0, zIndex: 2, textAlign: "left" }}
                    >
                      {String(value ?? "—")}
                      {codePlainName(rowLabel) && <small className="db-code-name">{codePlainName(rowLabel)}</small>}
                    </th>
                  );
                }
                const cellIdentity = { year: slice?.year ?? selection.year, table, row: rowLabel, column, value: numericValue };
                const selected = isCapturedDbCell(selectedObservation, cellIdentity);
                const picked = !selected && isCapturedDbCell(pickedObservation, cellIdentity);
                const intensity = numericValue == null || rowHeatMax[rowIndex] === 0
                  ? 0
                  : Math.min(1, Math.abs(numericValue) / rowHeatMax[rowIndex]);
                const cell = numericValue == null
                  ? null
                  : cells.find((candidate) => candidate.rowIndex === rowIndex && candidate.columnIndex === columnIndex) ?? null;
                return (
                  <td
                    key={column}
                    // A value cell's button carries the tooltip; the cell itself only explains empty/non-numeric values.
                    title={cell && numericValue != null ? undefined : columnHeaderHelp(column)}
                    style={intensity > 0
                      ? { background: numericValue != null && numericValue < 0 ? `rgba(227,73,72,${0.06 + intensity * 0.24})` : `rgba(42,120,214,${0.05 + intensity * 0.25})` }
                      : undefined}
                  >
                    {!cell || numericValue == null ? String(value ?? "—") : (
                      <button
                        ref={(button) => {
                          if (button) buttonRefs.current.set(cell.key, button);
                          else buttonRefs.current.delete(cell.key);
                        }}
                        type="button"
                        className={`db-observation-cell${selected ? " selected" : picked ? " picked" : ""}`}
                        tabIndex={activeCell?.key === cell.key ? 0 : -1}
                        aria-pressed={selected}
                        aria-label={`${dbCellAccessibleName(table, cell, selected)}${picked ? "，已选中，尚未改为报告材料" : ""}`}
                        title={dbCellTooltip(table, rowLabel, column, numericValue, locked)}
                        onFocus={() => setRoving({ scope: focusScopeKey, key: cell.key })}
                        onKeyDown={(event) => {
                          if (!DB_CELL_NAVIGATION_KEYS.includes(event.key)) return;
                          event.preventDefault();
                          const next = moveDbCell(cells, cell.key, event.key as DbCellNavigationKey, event.ctrlKey);
                          if (next) focusCell(next);
                        }}
                        onClick={() => onCapture(captureDbObservation(selection, {
                          row: rowLabel,
                          column,
                          value: numericValue,
                        }))}
                      >
                        {fmtDb(numericValue)}{selected ? " ✓" : ""}
                      </button>
                    )}
                  </td>
                );
              })}
              {showSummaries && <td>{dbRowSumText(dataColumns.map((column) => row[column]), slice?.row_summaries?.[rowIndex]?.slice_total ?? null)}</td>}
              {showSummaries && <td>{fmtDb(slice?.row_summaries?.[rowIndex]?.out ?? null)}</td>}
            </tr>
          ))}
          {slice && rows.length === 0 && (
            <tr><td colSpan={slice.columns.length || 1}>当前筛选下没有数据，请换一个国家或行业。</td></tr>
          )}
        </tbody>
        {slice && rows.length > 0 && (
          <tfoot>
            <tr style={{ fontWeight: 700, background: "#f7f8fb" }}>
              <th scope="row" style={{ position: "sticky", left: 0, zIndex: 2, background: "#f7f8fb", textAlign: "left" }}>本页列合计</th>
              {dataColumns.map((column) => <td key={column}>{fmtDb(columnTotals[column])}</td>)}
              {showSummaries && <td>{fmtDb((slice.row_summaries ?? []).reduce((sum, item) => sum + item.slice_total, 0))}</td>}
              {showSummaries && <td>—</td>}
            </tr>
          </tfoot>
        )}
      </table>
    </ScrollableRegion>
  );
}

const ROW_SUM_HELP = "本行在当前所选列上的合计，按未四舍五入的数值相加；前面有“≈”时，与表中显示的各格相加略有差别，来自四舍五入。";

/** 所选列之和 as shown, with "≈" in front when the cells as displayed do not add up to it (rounding), as steps 2–3 do. */
export function dbRowSumText(cells: readonly unknown[], total: number | null): string {
  const shown = String(fmtDb(total));
  if (total == null || !Number.isFinite(total)) return shown;
  const added = cells
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce((sum, value) => sum + Number(String(fmtDb(value)).replace(/,/g, "").replace("−", "-")), 0);
  return String(fmtDb(added)) === shown ? shown : `≈ ${shown}`;
}

export function ReleaseIntegrityStatus({ meta }: { meta: Meta | null }) {
  if (meta?.dataset?.integrity?.status !== "passed") return null;
  return (
    <div className="integrity-status" role="status">
      <b>数据已通过系统完整性检查</b>
      <span>文件和数据来源均已核对，无需再次检查；数据的局限将写入报告。</span>
    </div>
  );
}

export function DbLab({ state, releaseMeta }: { state: StepStateApi<DbStepState>; releaseMeta: Meta | null }) {
  const lastPages = useRef(1);
  const {
    data: meta,
    error: metaError,
    status: metaStatus,
    retry: retryMeta,
  } = useAsync<DbMeta>((signal) => api.dbMeta(signal), []);
  const [table, setTable] = useState<DbTableKind>("z");
  const [year, setYear] = useState<number | null>(null);
  const [rowCountry, setRowCountry] = useState("");
  const [colCountry, setColCountry] = useState("");
  const [rowSector, setRowSector] = useState("");
  const [colSector, setColSector] = useState("");
  const [page, setPage] = useState(1);
  // 点击单元格记录观测时，把同一棵表格子树切到全屏，便于就地核对行列方向。
  const [cellExpandSignal, setCellExpandSignal] = useState(0);
  // After the report is submitted, a clicked cell is only selected; it replaces the material on request.
  const [pickedCell, setPickedCell] = useState<Pick<DbStepState, "slice" | "observation"> | null>(null);
  // Recorded on request after submission: the strip then says to update the report on step 15.
  const [rechosen, setRechosen] = useState(false);

  useEffect(() => {
    if (!meta || !meta.default_year) return;
    setYear((current) => current ?? meta.default_year);
    setRowCountry((current) => current || (meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? ""));
    setColCountry((current) => current || (meta.countries.includes("USA") ? "USA" : meta.countries[0] ?? ""));
  }, [meta]);

  // 默认切片不写入实验快照；学生主动调整后才保存，避免报告声称他做过未发生的探索。
  const [pickedSlice, setPickedSlice] = useState(false);
  const restoredSlice = useRef(false);

  useEffect(() => {
    if (!meta || pickedSlice || restoredSlice.current || state.data === undefined) return;
    restoredSlice.current = true;
    const restored = restoreDbSlice(meta, state.data.slice);
    if (!restored) return;
    setYear(restored.year);
    setTable(restored.table);
    setRowCountry(restored.rowCountry);
    setColCountry(restored.colCountry);
    setRowSector(restored.rowSector);
    setColSector(restored.colSector);
    setPage(1);
  }, [meta, pickedSlice, state.data]);

  // 换筛选条件时在事件里直接回到第 1 页,避免先用旧页码发一次多余请求
  const withPageReset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
    setPickedSlice(true);
  };
  const pickYear = withPageReset(setYear);
  const pickRowCountry = withPageReset(setRowCountry);
  const pickColCountry = withPageReset(setColCountry);
  const pickRowSector = withPageReset(setRowSector);
  const pickColSector = withPageReset(setColSector);

  const ready = Boolean(meta && year && rowCountry && (table === "accounts" || colCountry));
  const sliceKey = JSON.stringify([
    ready, year, table, rowCountry, colCountry, rowSector, colSector, page,
  ]);
  const {
    data: sliceResult,
    error: sliceError,
    status: sliceStatus,
    retry: retrySlice,
  } = useAsync<{ sliceKey: string; slice: DbSlice | null }>(
    async (signal) => ({
      sliceKey,
      slice: ready && year
        ? await api.dbSlice({
          year,
          table,
          rowCountry,
          colCountry: table === "accounts" ? undefined : colCountry,
          rowSector,
          colSector: table === "accounts" ? undefined : colSector,
          page,
          pageSize: 25,
        }, signal)
        : null,
    }),
    [sliceKey],
  );
  const slice = sliceResult?.sliceKey === sliceKey ? sliceResult.slice : null;

  // 只有主动选择且数据加载成功后才写入自动快照。
  useEffect(() => {
    if (!slice || !year || !pickedSlice) return;
    state.save(sliceAutosave({
      year,
      table,
      rowCountry,
      colCountry,
      rowSector,
      colSector,
    }));
    // state 每次渲染都是新对象，不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, year, table, rowCountry, colCountry, pickedSlice]);

  // 无感记录：还没有观察值时，默认记录当前切片中最大的一格（标记为系统默认）；点击其他数值即替换。
  // The app renders labs only after the session has loaded, so this never overwrites a saved cell.
  const hasObservation = Boolean(state.data?.observation);
  useEffect(() => {
    if (!slice || hasObservation) return;
    const cell = defaultDbCell(slice);
    if (!cell) return;
    const patch = captureDbObservation(
      { year: slice.year, table: slice.table, rowCountry, colCountry, rowSector, colSector },
      { row: cell.row, column: cell.column, value: cell.value },
    );
    state.save({ observation: { ...patch.observation!, auto: true } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, hasObservation]);

  if (metaError) {
    return (
      <div className="error-box async-error" role="alert">
        <span>{userFacingRequestError(metaError, "OECD ICIO 数据读取失败")}</span>
        <button type="button" className="secondary" onClick={retryMeta}>重试</button>
      </div>
    );
  }
  if (!meta) {
    return (
      <p className="muted" role="status" aria-live="polite" aria-busy={metaStatus === "loading"}>
        正在载入 OECD ICIO 2023 版数据，第一次打开可能要稍等…
      </p>
    );
  }

  // While the next page loads there is no slice; keep the last page count so the pager does not collapse to
  // "1 / 1" (which disabled the button that had focus).
  const pages = slice ? Math.max(1, Math.ceil(slice.total / slice.page_size)) : lastPages.current;
  lastPages.current = pages;
  const colOptions = table === "y" ? meta.final_demand_categories : meta.sectors;
  const activeTable = DB_TABLES.find((t) => t.key === table)!;
  const selectedObservation = state.data?.observation;
  const observationSource = selectedObservation ? observationSourceLabel(selectedObservation) : null;

  if (!meta.years.length) {
    return (
      <div>
        <div className="warnbox">
          暂时没有可用的 ICIO 数据，请联系老师。
        </div>
      </div>
    );
  }

  return (
    <div>
      <FullscreenPanel
        title={`步骤 1 · ${cjkJoin(activeTable.label, "原始数据表")}`}
        variant="table"
        buttonLabel="全屏查看"
        enabled={table !== "accounts"}
        autoExpandSignal={cellExpandSignal}
        triggerInContent
      >
      <div className="controls">
        <LabeledControl label="年份">
          {(id) => (
            <select id={id} value={year ?? ""} onChange={(e) => pickYear(Number(e.target.value))}>
              {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
        </LabeledControl>
        <div className="seg db-table-seg" role="group" aria-label="选择数据表">
          {DB_TABLES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={table === item.key ? "on" : ""}
              aria-pressed={table === item.key}
              onClick={() => {
                setTable(item.key);
                setColCountry((current) => dbColumnCountryForTable(meta, current, item.key));
                setColSector("");
                setPage(1);
                setPickedSlice(true);
              }}
            >
              {item.label}
              {/* Hidden from the accessible name, which stays the table's short label. */}
              {item.detail && <small className="db-table-seg-detail" aria-hidden="true">（{item.detail}）</small>}
            </button>
          ))}
        </div>
        <FullscreenTriggerSlot />
      </div>

      <div className="controls">
        <LabeledControl label={table === "accounts" ? "国家（行）" : "供给国（行）"}>
          {(id) => (
            <select id={id} value={rowCountry} onChange={(e) => pickRowCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label={table === "accounts" ? "行业（行）" : "供给行业（行）"}>
          {(id) => (
            <select id={id} value={rowSector} onChange={(e) => pickRowSector(e.target.value)}>
              <option value="">全部</option>
              {meta.sectors.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
            </select>
          )}
        </LabeledControl>
        {table !== "accounts" && (
          <>
            <LabeledControl label={table === "y" ? "需求国（列）" : "使用国（列）"}>
              {(id) => (
                <select id={id} value={colCountry} onChange={(e) => pickColCountry(e.target.value)}>
                  {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
                </select>
              )}
            </LabeledControl>
            <LabeledControl label={table === "y" ? "需求类别（列）" : "使用行业（列）"}>
              {(id) => (
                <select id={id} value={colSector} onChange={(e) => pickColSector(e.target.value)}>
                  <option value="">全部</option>
                  {colOptions.map((s) => (
                    <option key={s} value={s}>{table === "y" ? (FD_NAMES[s] ? `${s} ${FD_NAMES[s]}` : s) : sectorLabel(s)}</option>
                  ))}
                </select>
              )}
            </LabeledControl>
          </>
        )}
        {!slice && (
          <span className="muted" role="status">{sliceStatus === "error" ? "加载失败" : "加载中…"}</span>
        )}
      </div>

      {sliceError && (
        <div className="error-box async-error" role="alert" style={{ marginBottom: 14 }}>
          <span>{userFacingRequestError(sliceError, "表格数据加载失败")}</span>
          <button type="button" className="secondary" onClick={retrySlice}>重试</button>
        </div>
      )}
      <div className="observation-strip db-observation" aria-live="polite">
        <b>已记录的单元格</b>
        {selectedObservation ? (
          <span>
            {/* 观察值跨表页签保留；读法必须用记录时的表类型,不能用当前页签的。 */}
            {dbObservationSentence((selectedObservation.table as DbTableKind | undefined) ?? table, selectedObservation.row, selectedObservation.column)} = {fmtDb(selectedObservation.value)} 百万美元
            {observationSource ? `（${observationSource}）` : ""}
            {selectedObservation.value === 0 ? `。${zeroCellNote((selectedObservation.table as DbTableKind | undefined) ?? table)}` : ""}
            {selectedObservation.auto && !state.materialLocked ? "。系统已先记录这个单元格，点击其他数值即可替换。" : ""}
          </span>
        ) : <span className="empty">尚未记录</span>}
        {state.materialLocked && <span className="muted">{MATERIAL_LOCKED_NOTE.replace("浏览", "点击单元格")}{rechosen && !pickedCell ? `已改为记录这个单元格。${MATERIAL_RECHOSEN_NEXT}` : ""}</span>}
        {state.materialLocked && pickedCell?.observation && !sameJsonValue(pickedCell.observation, selectedObservation) && (
          <span className="db-picked">
            你选中的：{dbObservationSentence((pickedCell.observation.table as DbTableKind | undefined) ?? table, pickedCell.observation.row, pickedCell.observation.column)} = {fmtDb(pickedCell.observation.value)} 百万美元{observationSourceLabel(pickedCell.observation) ? `（${observationSourceLabel(pickedCell.observation)}）` : ""}
            <button type="button" className="secondary" onClick={() => { state.save(pickedCell); setPickedCell(null); setRechosen(true); }}>改为记录这个单元格（之后需在步骤 15 更新报告）</button>
          </span>
        )}
      </div>
      {/* One action line; the reading rules, legend and identities live in a single fold-out. */}
      <div className="db-reading db-fullscreen-note">
        <span>
          {/* The locked notice is already in the strip above; this line only says what a click does. */}
          {state.materialLocked
            ? `点击数值只会选中这个单元格${table === "accounts" ? "" : "（表格会放大到全屏）"}；要换成报告材料，请再点上方出现的确认按钮。`
            : `点击任一数值即可记录这个单元格${table === "accounts" ? "" : "，表格会放大到全屏，方便核对方向"}。`}
          {table === "accounts" ? "行是国家×行业，列是账户项" : `行是供给方，列是${table === "y" ? "最终需求" : "使用方"}`}；单位：百万美元。
        </span>
        <details className="db-reading-notes">
          <summary>读表说明</summary>
          <ul>
            <li><b>怎么读：</b>{HOW_TO_READ[table]}</li>
            <li><b>记录规则：</b>系统先自动记录本页数值最大的单元格；点击其他单元格即改为记录该单元格。切换数据表或筛选条件不影响已记录的单元格。</li>
            <li><b>账户与符号：</b>{STEP1_ACCOUNT_LEGEND}</li>
            {table !== "accounts" && <li><b>恒等式：</b>{STEP1_OUT_IDENTITY_GUIDE}</li>}
            <li><b>键盘：</b>Tab 进入表格后，方向键逐格移动，Home / End 到行首 / 行尾，Ctrl+Home / Ctrl+End 到表首 / 表尾，PageUp / PageDown 上下跳 10 行；Enter 或空格记录当前单元格。</li>
          </ul>
        </details>
      </div>
      <DbSliceTable
        slice={slice}
        table={table}
        focusScopeKey={sliceKey}
        selection={{
          year: slice?.year ?? year ?? 0,
          table,
          rowCountry,
          colCountry,
          rowSector,
          colSector,
        }}
        selectedObservation={selectedObservation}
        pickedObservation={state.materialLocked ? pickedCell?.observation : undefined}
        locked={state.materialLocked}
        onCapture={(patch) => {
          if (state.materialLocked) setPickedCell(patch);
          else state.save(patch);
          setCellExpandSignal((value) => value + 1);
        }}
      />
      <div style={{ marginTop: 12 }}>
        <Pager page={page} pages={pages} total={slice?.total} onChange={setPage} />
      </div>
      </FullscreenPanel>

      {/* 单层折叠：早前这里是“外层 details 套一个内层 details”，学生要点击两次才能看到正文。 */}
      <details className="card accent concept-card db-structure-details">
        <summary className="kicker">数据来源与其他投入产出数据库</summary>
        {/* Dataset facts and the integrity check need no student action, so they sit here, not above the table. */}
        <ReleaseIntegrityStatus meta={releaseMeta} />
        <p className="muted db-facts">
          原始年份 {meta.years[0]}–{meta.years.at(-1)} · {meta.countries.includes("ROW") ? meta.countries.length - 1 : meta.countries.length} 个经济体{meta.countries.includes("ROW") ? " + 世界其他地区（ROW）" : ""} · {meta.sectors.length} 个行业
        </p>
        <DatabaseGuide meta={meta} releaseMeta={releaseMeta} />
      </details>
    </div>
  );
}
