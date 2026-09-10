import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../../a11y";
import { api } from "../../api";
import { FullscreenPanel } from "../../fullscreen-panel";
import type { DbMeta, DbSlice, DbTableKind, Meta, QuizCompletionState, StepStateApi } from "../../types";
import { userFacingRequestError } from "../../user-facing-error";
import { countryLabel, sectorLabel } from "../../viz";
import { fmtDb, Pager, useAsync } from "../shared";

const DB_TABLES: { key: DbTableKind; label: string; hint: string }[] = [
  { key: "z", label: "中间投入 Z", hint: "供给国-行业(行) × 使用国-行业(列)" },
  { key: "y", label: "最终需求 Y", hint: "供给国-行业(行) × 目的国需求类别(列)" },
  { key: "accounts", label: "账户项", hint: "TLS / VA / OUT 转置为国家-行业行" },
];

/** 首列表头。后端返回的列名就是字面的 "row",直接显示对学生没有信息量。 */
const ROW_HEADER: Record<DbTableKind, { label: string; title: string }> = {
  z: { label: "供给国×行业(行)", title: "每一行是提供中间投入的一方:某国某行业" },
  y: { label: "供给国×行业(行)", title: "每一行是提供最终产品的一方:某国某行业" },
  accounts: { label: "国家×行业(行)", title: "每一行是一个国家×行业;列为该行业的账户项" },
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
  if (table === "z") return `使用国×行业(列)→ ${country}`;
  if (table === "y") return `目的国×最终需求(列)→ ${country}`;
  return "账户项(列)";
}

/** 表格怎么读:行是供给方、列是使用方——这是投入产出表最容易被看反的一点,
 *  因为"行"虽然横向延伸,它的标签却竖排在最左侧。读法一律锚定标签的视觉位置
 *  (左侧竖排/上方横排),不再依赖"行/列"抽象词的二次换算。 */
const HOW_TO_READ: Record<DbTableKind, string> = {
  z: "每个数值 = 它左侧竖排标签(行:供给国×行业) 向 它上方横排标签(列:使用国×行业) 供给的中间投入。注意:行的标签虽然竖排在最左,它仍然是「行」。单位:Million USD(百万美元)。",
  y: "每个数值 = 它左侧竖排标签(行:供给国×行业) 被 它上方横排标签(列:目的国×需求类别) 吸收的最终需求金额。注意:行的标签虽然竖排在最左,它仍然是「行」。单位:Million USD(百万美元)。",
  accounts: "每一行是一个「国家×行业」,列是该行业的账户项(TLS / VA / OUT);此表没有列方向的国家维度。单位:Million USD(百万美元)。",
};

const ACCOUNT_HELP: Record<string, string> = {
  TLS: "产品税减补贴。为负表示该账户合计为净补贴；步骤2 的 taxsub 是其沿投入产出链传导后的出口含量。",
  VA: "增加值：劳动报酬、资本回报等本地创造的价值，是步骤3生产活动分解的总来源。",
  OUT: "总产出。两种完整恒等式为：按行 OUT = Z 行和 + Y 行和；按列 OUT = Z 列和 + VA + TLS。系统发布前已自动校验这些会计恒等式并披露诊断。",
};

/** OECD ICIO 最终需求类别缩写 → 中文名(Y 表列名形如 USA_HFCE:目的国_需求类别) */
export const STEP1_ACCOUNT_LEGEND = "TLS = 产品税减补贴（负 TLS 表示净补贴，不是缺失）；VA = 增加值；OUT = 总产出；INVNT = 存货变化（负 INVNT 表示有符号的存货减少调整，不是缺失）。";
export const STEP1_OUT_IDENTITY_GUIDE = "按行 OUT = Z 行和 + Y 行和；按列 OUT = Z 列和 + VA + TLS。筛选后的切片合计与本页列合计都只是完整和的一部分。";

const FD_HELP: Record<string, string> = {
  HFCE: "居民最终消费支出",
  NPISH: "为居民服务的非营利机构消费",
  GGFC: "政府最终消费支出",
  GFCF: "固定资本形成总额(投资)",
  INVNT: "存货变化（有符号调整）；负值表示存货减少，不是缺失值",
  DPABR: "居民境外直接购买(出境旅行等消费)",
};

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
  { name: "WIOD 2016 release", org: "格罗宁根大学", coverage: "43 国 + ROW · 56 行业 · 2000–2014", focus: "课程对比快照；含社会经济与环境账户，当前表不代表实时版本" },
  { name: "Eora26（课程快照）", org: "悉尼大学", coverage: "约 190 经济体 · 26 行业", focus: "覆盖较广 + 环境卫星账户；具体年份和地区数应以所下载版本元数据为准" },
  { name: "EXIOBASE 3（课程快照）", org: "多机构联合", coverage: "约 49 区域 · 约 200 产品", focus: "环境扩展较细；具体覆盖随 3.x release 变化" },
  { name: "ADB MRIO（课程快照）", org: "亚洲开发银行", coverage: "60+ 经济体 · 35 行业", focus: "亚太侧重；具体覆盖应以下载版本为准" },
];

/** 数据库速览:说明还有哪些全球投入产出库,并明确本系统默认用 OECD ICIO 及原因。 */
function DatabaseGuide({ meta }: { meta: DbMeta }) {
  const namedEconomies = meta.countries.includes("ROW") ? meta.countries.length - 1 : meta.countries.length;
  const icioCoverage = `${namedEconomies} 个具名经济体 + ROW · ${meta.sectors.length} 行业 · ${meta.years[0]}–${meta.years.at(-1)}（载入）`;
  return (
    <details className="card accent concept-card db-guide">
      <summary className="kicker">全球投入产出数据库一览 · 本系统默认使用 OECD ICIO</summary>
      <p style={{ maxWidth: 820 }}>
        研究全球价值链,需要一张“谁向谁供货”的<b>跨国投入产出表</b>。主流数据库各有侧重——下表是截至 2026-08 的课程比较快照，不是实时目录；覆盖范围、行业/产品口径与更新节奏都不同:
      </p>
      <ScrollableRegion className="table-wrap" label="全球投入产出数据库对比表，可横向滚动" style={{ marginTop: 10 }}>
        <table className="data-table db-guide-table">
          <thead>
            <tr><th>数据库</th><th>编制方</th><th>覆盖</th><th>侧重 / 特点</th></tr>
          </thead>
          <tbody>
            <tr className="db-guide-default">
              <td><b>OECD ICIO</b> ✓ 本系统默认</td>
              <td>OECD</td>
              <td>{icioCoverage}</td>
              <td>以各国官方国民账户为基础;适合计算增加值贸易 / GVC 指标(本系统的 WWZ 聚合项、OECD TLS 扩展与 WWYZ 指标均基于它)</td>
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
        本系统使用 <b>OECD ICIO</b>(2023 版,当前载入 {meta.years[0]}–{meta.years.at(-1)})作为 GVC <b>指标输入</b>并生成派生结果；这项 OECD 来源声明不覆盖回归控制或政策情景。
        回归里的<b>模拟宏观控制</b>是以 ICIO 派生规模为锚的确定性教学 mock，不是 WDI 数据或 IMF 观测；政策冲击与政策情景也是教学编码，不是 OECD 数据。切换到其他数据库需替换原始表与解析器,不在本教学系统范围内;各库的覆盖数字随版本更新、分类口径不同,不能直接横向比较。
      </p>
    </details>
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
  const help = FD_HELP[column.slice(sep + 1)];
  return help ? `${column.slice(0, sep)} ${help}` : column;
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

export type DbCellNavigationKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

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
  const candidates = cells.filter((cell) => (
    cell.columnIndex === current.columnIndex
    && (key === "ArrowUp" ? cell.rowIndex < current.rowIndex : cell.rowIndex > current.rowIndex)
  ));
  return (key === "ArrowUp" ? candidates.at(-1) : candidates[0]) || current;
}

export function dbCellAccessibleName(
  table: DbTableKind,
  cell: Pick<DbCellCoordinate, "row" | "column" | "value">,
  recorded: boolean,
): string {
  const column = table === "y" ? formatYColumnHeader(cell.column) : cell.column;
  if (table === "accounts") {
    return `${cell.row}，${column}，值 ${fmtDb(cell.value)} Million USD（百万美元），${recorded ? "已记录" : "未记录"}；按 Enter 或空格记录`;
  }
  const colRole = table === "y" ? "列·最终需求" : "列·使用方";
  return `${cell.row}(行·供给方) → ${column}(${colRole})，值 ${fmtDb(cell.value)} Million USD（百万美元），${recorded ? "已记录" : "未记录"}；按 Enter 或空格记录`;
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

/** 列表头悬停说明:Y 表需求类别与账户项查表,Z 表退回国家×行业中文名。 */
function columnHeaderHelp(column: string): string | undefined {
  return columnHelp(column) ?? rowColumnCodeHelp(column);
}

/** 观察值方向句:把 "A × B = v" 改写成 "A(行·供给方) → B(列·使用方) = v" 的完整读法,
 *  让学生在记录现场就地校验行列方向。 */
export function dbObservationSentence(table: DbTableKind, row: string, column: string): string {
  if (table === "accounts") return `${row} 的 ${column}`;
  const rowPart = splitRowColumnCode(row);
  const rowLabel = rowPart.country ? `${countryLabel(rowPart.country)}·${rowPart.rest}` : row;
  if (table === "y") {
    return `${rowLabel}(行·供给方) → ${formatYColumnHeader(column)}(列·最终需求)`;
  }
  const colPart = splitRowColumnCode(column);
  const colLabel = colPart.country ? `${countryLabel(colPart.country)}·${colPart.rest}` : column;
  return `${rowLabel}(行·供给方) → ${colLabel}(列·使用方)`;
}

export function DbSliceTable({
  slice,
  table,
  focusScopeKey,
  selection,
  selectedObservation,
  onCapture,
  expandOnCapture = false,
}: {
  slice: DbSlice | null;
  table: DbTableKind;
  focusScopeKey: string;
  selection: DbSliceSelection;
  selectedObservation?: DbStepState["observation"];
  onCapture: (patch: Pick<DbStepState, "slice" | "observation">) => void;
  /**
   * 只是文案开关：激活单元格是否还会进入全屏。账户项页签不提供全屏，因此不能向学生
   * 宣称它会展开。实际展开由父组件的 autoExpandSignal 控制。
   */
  expandOnCapture?: boolean;
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
  const rowHeatMax = rows.map((row) => (
    Math.max(...dataColumns.map((column) => Math.abs(typeof row[column] === "number" ? row[column] : 0)), 0)
  ));
  const columnTotals = Object.fromEntries(dataColumns.map((column) => [
    column,
    rows.reduce((sum, row) => sum + (typeof row[column] === "number" ? row[column] : 0), 0),
  ]));
  const showSummaries = table !== "accounts" && Boolean(slice?.row_summaries?.length);
  const activeTable = DB_TABLES.find((item) => item.key === table)!;

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
      label={`${activeTable.label}数据表，可横向滚动`}
      focusable={activeCell == null}
    >
      <table className="data-table db-table">
        <caption>
          {`${activeTable.label}数据表 · 单位：Million USD（百万美元）。Tab 进入一个数据单元格；方向键和 Home、End 在本页有限数值单元格间移动；Enter 或空格记录；Tab 或 Shift+Tab 离开表格。`}
        </caption>
        <thead>
          <tr className="db-axis-row">
            <th
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
              {columnAxisBand(table, selection.colCountry)}
            </th>
            {showSummaries && (
              <th colSpan={2} className="db-axis-cols" scope="colgroup" title="当前筛选口径下的切片合计与对应 OUT">
                本页切片口径
              </th>
            )}
          </tr>
          <tr>
            {dataColumns.map((column) => (
              <th
                key={column}
                scope="col"
                title={columnHeaderHelp(column)}
                aria-label={table === "y" ? formatYColumnHeader(column) : (rowColumnCodeHelp(column) ?? column)}
              >
                {`${table === "y" ? formatYColumnHeader(column) : column}${columnHeaderHelp(column) ? " ⓘ" : ""}`}
              </th>
            ))}
            {showSummaries && <th scope="col" title="当前筛选列在该行的合计">切片合计</th>}
            {showSummaries && <th scope="col" title={ACCOUNT_HELP.OUT}>对应 OUT ⓘ</th>}
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
                    </th>
                  );
                }
                const selected = isCapturedDbCell(selectedObservation, {
                  year: slice?.year ?? selection.year,
                  table,
                  row: rowLabel,
                  column,
                  value: numericValue,
                });
                const intensity = numericValue == null || rowHeatMax[rowIndex] === 0
                  ? 0
                  : Math.min(1, Math.abs(numericValue) / rowHeatMax[rowIndex]);
                const cell = numericValue == null
                  ? null
                  : cells.find((candidate) => candidate.rowIndex === rowIndex && candidate.columnIndex === columnIndex) ?? null;
                return (
                  <td
                    key={column}
                    title={columnHeaderHelp(column) ?? (numericValue != null ? `${column}: ${fmtDb(numericValue)}` : undefined)}
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
                        className={`db-observation-cell${selected ? " selected" : ""}`}
                        tabIndex={activeCell?.key === cell.key ? 0 : -1}
                        aria-pressed={selected}
                        aria-label={dbCellAccessibleName(table, cell, selected)}
                        title={`${dbObservationSentence(table, rowLabel, column)} = ${fmtDb(numericValue)} Million USD（百万美元）；点击记录这个观察值${expandOnCapture ? "并进入全屏查看" : ""}`}
                        onFocus={() => setRoving({ scope: focusScopeKey, key: cell.key })}
                        onKeyDown={(event) => {
                          if (!(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as string[]).includes(event.key)) return;
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
              {showSummaries && <td>{fmtDb(slice?.row_summaries?.[rowIndex]?.slice_total ?? null)}</td>}
              {showSummaries && <td>{fmtDb(slice?.row_summaries?.[rowIndex]?.out ?? null)}</td>}
            </tr>
          ))}
          {slice && rows.length === 0 && (
            <tr><td colSpan={slice.columns.length || 1}>无匹配记录</td></tr>
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

export function ReleaseIntegrityStatus({ meta }: { meta: Meta | null }) {
  if (meta?.dataset?.integrity?.status !== "passed") return null;
  return (
    <div className="integrity-status" role="status">
      <b>当前数据已通过系统自动完整性验证</b>
      <span>文件哈希、表结构、键覆盖与来源绑定均已验证；数值、经济含义与研究设计诊断由系统保留并在报告中披露，无需学生另做校验。</span>
    </div>
  );
}

export function DbLab({ state, releaseMeta }: { state: StepStateApi<DbStepState>; releaseMeta: Meta | null }) {
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

  if (metaError) {
    return (
      <div className="error-box async-error" role="alert">
        <span>{userFacingRequestError(metaError, "OECD ICIO 原始文件索引读取失败")}</span>
        <button type="button" className="secondary" onClick={retryMeta}>重新验证并重试</button>
      </div>
    );
  }
  if (!meta) {
    return (
      <p className="muted" role="status" aria-live="polite" aria-busy={metaStatus === "loading"}>
        正在验证 OECD ICIO 2023 版原始文件并读取索引；全新部署首次启动会先完成完整性校验…
      </p>
    );
  }

  const selectedFile = meta.files.find((f) => f.year === year);
  const pages = slice ? Math.max(1, Math.ceil(slice.total / slice.page_size)) : 1;
  const colOptions = table === "y" ? meta.final_demand_categories : meta.sectors;
  const activeTable = DB_TABLES.find((t) => t.key === table)!;
  const selectedObservation = state.data?.observation;
  const observationSource = selectedObservation ? observationSourceLabel(selectedObservation) : null;

  if (!meta.years.length) {
    return (
      <div>
        <div className="warnbox">
          未找到本地 OECD ICIO 原始 CSV。请将 ICIO2023_YYYY.csv 放入 OECD_ICIO/ 后刷新本页。
        </div>
      </div>
    );
  }

  return (
    <div>
      <ReleaseIntegrityStatus meta={releaseMeta} />
      <div className="db-summary">
        <span>原始年份 {meta.years[0]}-{meta.years.at(-1)}</span>
        <span>{meta.countries.includes("ROW") ? meta.countries.length - 1 : meta.countries.length} 个具名经济体 + ROW 剩余地区账户</span>
        <span>{meta.sectors.length} 个行业</span>
        <span>{meta.n_rows.toLocaleString("zh-CN")} 行 × {meta.n_columns.toLocaleString("zh-CN")} 列</span>
        {selectedFile && <span>{selectedFile.file}</span>}
      </div>

      <FullscreenPanel
        title={`步骤 1 · ${activeTable.label}原始数据表`}
        variant="table"
        buttonLabel="全屏查看"
        enabled={table !== "accounts"}
        autoExpandSignal={cellExpandSignal}
      >
      <div className="controls">
        <LabeledControl label="年份">
          {(id) => (
            <select id={id} value={year ?? ""} onChange={(e) => pickYear(Number(e.target.value))}>
              {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
        </LabeledControl>
        <div className="seg db-table-seg">
          {DB_TABLES.map((item) => (
            <button
              key={item.key}
              className={table === item.key ? "on" : ""}
              onClick={() => {
                setTable(item.key);
                setColCountry((current) => dbColumnCountryForTable(meta, current, item.key));
                setColSector("");
                setPage(1);
                setPickedSlice(true);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="muted">{activeTable.hint}</span>
      </div>

      <div className="controls">
        <LabeledControl label="供给国(行)">
          {(id) => (
            <select id={id} value={rowCountry} onChange={(e) => pickRowCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="供给行业(行)">
          {(id) => (
            <select id={id} value={rowSector} onChange={(e) => pickRowSector(e.target.value)}>
              <option value="">全部</option>
              {meta.sectors.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
            </select>
          )}
        </LabeledControl>
        {table !== "accounts" && (
          <>
            <LabeledControl label={table === "y" ? "需求国(列)" : "使用国(列)"}>
              {(id) => (
                <select id={id} value={colCountry} onChange={(e) => pickColCountry(e.target.value)}>
                  {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
                </select>
              )}
            </LabeledControl>
            <LabeledControl label={table === "y" ? "最终需求(列)" : "使用行业(列)"}>
              {(id) => (
                <select id={id} value={colSector} onChange={(e) => pickColSector(e.target.value)}>
                  <option value="">全部</option>
                  {colOptions.map((s) => (
                    <option key={s} value={s}>{table === "y" ? (FD_HELP[s] ? `${s} ${FD_HELP[s]}` : s) : sectorLabel(s)}</option>
                  ))}
                </select>
              )}
            </LabeledControl>
          </>
        )}
        <span className="muted" role="status">
          {slice ? `本切片 ${slice.total} 个供给行业行` : sliceStatus === "error" ? "加载失败" : "加载中…"}
        </span>
      </div>

      {sliceError && (
        <div className="error-box async-error" role="alert" style={{ marginBottom: 14 }}>
          <span>{userFacingRequestError(sliceError, "数据切片加载失败")}</span>
          <button type="button" className="secondary" onClick={retrySlice}>重试</button>
        </div>
      )}
      <div className="tipbox db-fullscreen-note" style={{ marginBottom: 10 }}>
        <b>怎么读这张表：</b>{HOW_TO_READ[table]}
      </div>
      <div className="tipbox db-fullscreen-note" style={{ marginBottom: 10 }}>
        <b>记录一个观察值：</b>所有数值单位均为 <b>Million USD（百万美元）</b>。点击数值单元格即记录该值{table === "accounts" ? "" : "并自动进入全屏查看，便于核对行列方向"}；也可按 Tab 进入表格后用方向键 / Home / End 移动、按 Enter 或空格记录；再按 Tab 可离开表格。系统只在明确激活时保存该格的行、列与数值。切换 Z / Y / 账户项或筛选不会丢掉已记录的单元格；记录另一个单元格才会覆盖。
      </div>
      <div className="tipbox db-fullscreen-note" style={{ marginBottom: 10 }}>
        <b>账户与符号图例（始终适用）：</b> {STEP1_ACCOUNT_LEGEND}
      </div>
      <div className="observation-strip" aria-live="polite">
        <b>已选原始数据点</b>
        {selectedObservation ? (
          <span>
            {/* 观察值跨表页签保留；读法必须用记录时的表类型,不能用当前页签的。 */}
            {dbObservationSentence((selectedObservation.table as DbTableKind | undefined) ?? table, selectedObservation.row, selectedObservation.column)} = {fmtDb(selectedObservation.value)} Million USD（百万美元）
            {observationSource ? `（${observationSource}）` : ""}
          </span>
        ) : <span>尚未选择</span>}
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
        expandOnCapture={table !== "accounts"}
        onCapture={(patch) => {
          state.save(patch);
          setCellExpandSignal((value) => value + 1);
        }}
      />
      {table !== "accounts" && slice && (
        <div className="tipbox db-fullscreen-note" style={{ marginTop: 12 }}>
          两条完整口径恒等式：<b>{STEP1_OUT_IDENTITY_GUIDE}</b> 差额来自未展示的国家、行业或最终需求列。
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Pager page={page} pages={pages} total={slice?.total} onChange={setPage} />
      </div>
      </FullscreenPanel>

      <details className="card concept-card db-structure-details">
        <summary className="kicker">进一步理解 ICIO 表结构与账户项</summary>
        <DatabaseGuide meta={meta} />
      </details>
    </div>
  );
}
