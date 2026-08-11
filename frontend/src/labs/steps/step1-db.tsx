import { useEffect, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../../a11y";
import { api } from "../../api";
import { economyAccountCoverageLabel } from "../../economy-coverage";
import type { DbMeta, DbSlice, DbTableKind, QuizCompletionState, StepStateApi } from "../../types";
import { userFacingRequestError } from "../../user-facing-error";
import { countryLabel, sectorLabel } from "../../viz";
import { fmtDb, Pager, useAsync } from "../shared";

const DB_TABLES: { key: DbTableKind; label: string; hint: string }[] = [
  { key: "z", label: "中间投入 Z", hint: "供给方经济体×行业（行） × 使用方经济体×行业（列）" },
  { key: "y", label: "最终需求 Y", hint: "供给方经济体×行业（行） × 目的经济体需求类别（列）" },
  { key: "accounts", label: "账户项", hint: "TLS、VA 和 OUT 按经济体×行业排列" },
];

/** 首列表头。后端返回的列名就是字面的 "row",直接显示对学生没有信息量。 */
const ROW_HEADER: Record<DbTableKind, { label: string; title: string }> = {
  z: { label: "供给方经济体×行业（行）", title: "每一行表示提供中间投入的经济体与行业" },
  y: { label: "供给方经济体×行业（行）", title: "每一行表示提供最终产品的经济体与行业" },
  accounts: { label: "经济体×行业（行）", title: "每一行表示一个经济体与行业，列为对应账户项" },
};

/** 表格怎么读:行是供给方、列是使用方——这是投入产出表最容易被看反的一点,
 *  因为"行"虽然横向延伸,它的标签却竖排在最左侧。按表类型给出具体读法。 */
const HOW_TO_READ: Record<DbTableKind, string> = {
  z: "行是供给方，列是使用方。某一格表示行方经济体×行业向列方经济体×行业提供的中间投入，单位为百万美元。",
  y: "行是供给方，列是最终需求去向。某一格表示行方经济体×行业被列方目的经济体与需求类别吸收的金额，单位为百万美元。",
  accounts: "每一行表示一个经济体×行业，列是税收减补贴（TLS）、增加值（VA）和总产出（OUT）账户；此表没有列方向的经济体维度。",
};

const ACCOUNT_HELP: Record<string, string> = {
  TLS: "产品税减补贴。负值表示该账户合计为净补贴；步骤 3 的 taxsub 是它沿投入产出链传导后的出口含量。",
  VA: "增加值：劳动报酬、资本回报等本地创造的价值，是步骤 4 生产活动分解的总来源。",
  OUT: "总产出。按行计算应等于中间使用 Z 的行和加最终需求 Y 的行和；步骤 2 会检验这条会计恒等式。",
};

/** OECD ICIO 最终需求类别缩写 → 中文名(Y 表列名形如 USA_HFCE:目的国_需求类别) */
const FD_HELP: Record<string, string> = {
  HFCE: "居民最终消费支出",
  NPISH: "为居民服务的非营利机构消费",
  GGFC: "政府最终消费支出",
  GFCF: "固定资本形成总额（投资）",
  INVNT: "存货变化",
  DPABR: "居民境外直接购买（出境旅行等消费）",
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
  { name: "WIOD", org: "格罗宁根大学", coverage: "43 个经济体 · 56 个行业 · 2000–2014", focus: "GVC 研究的经典数据源，含社会经济与环境账户；已停止更新" },
  { name: "Eora / Eora26", org: "悉尼大学", coverage: "约 190 个经济体 · 26 个行业（精简版）", focus: "经济体覆盖广，并包含环境卫星账户；行业口径较粗" },
  { name: "EXIOBASE 3", org: "多机构联合", coverage: "约 49 个区域 · 约 200 种产品", focus: "环境扩展较细，侧重可持续与足迹分析" },
  { name: "ADB MRIO", org: "亚洲开发银行", coverage: "60 多个经济体 · 35 个行业", focus: "亚太经济体覆盖较细，大体延续 WIOD 口径" },
];

/** 数据库速览:说明还有哪些全球投入产出库,并明确本系统默认用 OECD ICIO 及原因。 */
function DatabaseGuide({ meta }: { meta: DbMeta }) {
  const icioCoverage = `${meta.countries.length} 经济体 · ${meta.sectors.length} 行业 · ${meta.years[0]}–${meta.years.at(-1)}（载入）`;
  return (
    <details className="card accent concept-card db-guide">
      <summary className="kicker">全球投入产出数据库一览 · 本系统默认使用 OECD ICIO</summary>
      <p style={{ maxWidth: 820 }}>
        研究全球价值链需要一张描述“谁向谁供货”的<b>跨国投入产出表</b>。主流数据库在覆盖范围、行业或产品口径以及更新节奏上各有侧重：
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
              <td>以各经济体国民账户为基础；本课程的 WWZ、WWYZ 等增加值贸易指标均由它计算</td>
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
        本课程全程使用 <b>OECD ICIO</b>（2023 版，当前载入 {meta.years[0]}–{meta.years.at(-1)}），其经济体×行业口径适合本课程的 GVC 指标计算。
        各数据库的覆盖数字会随版本更新，分类口径也不同，不能直接横向比较。
      </p>
    </details>
  );
}

/** 步骤1:本地 OECD ICIO 原始表浏览 */
/** 自动保存学生主动查看过的切片与单元格，供恢复界面和生成报告。 */
interface DbStepState extends QuizCompletionState, Record<string, unknown> {
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
  };
}

interface DbSliceSelection {
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
  observation: NonNullable<DbStepState["observation"]>,
): Pick<DbStepState, "slice" | "observation"> {
  return { slice: dbSliceSnapshot(selection), observation };
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

export function DbLab({ state }: { state: StepStateApi<DbStepState> }) {
  const { data: meta, error: metaError } = useAsync<DbMeta>(() => api.dbMeta(), []);
  const [table, setTable] = useState<DbTableKind>("z");
  const [year, setYear] = useState<number | null>(null);
  const [rowCountry, setRowCountry] = useState("");
  const [colCountry, setColCountry] = useState("");
  const [rowSector, setRowSector] = useState("");
  const [colSector, setColSector] = useState("");
  const [page, setPage] = useState(1);

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
    async () => ({
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
        })
        : null,
    }),
    [sliceKey],
  );
  const slice = sliceResult?.sliceKey === sliceKey ? sliceResult.slice : null;

  // 只有主动选择且数据加载成功后才写入自动快照。
  useEffect(() => {
    if (!slice || !year || !pickedSlice) return;
    state.save({
      slice: dbSliceSnapshot({
        year,
        table,
        rowCountry,
        colCountry,
        rowSector,
        colSector,
      }),
      // 单元格必须属于当前成功返回的切片；筛选变化后清空旧选择。
      observation: undefined,
    });
    // state 每次渲染都是新对象，不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, year, table, rowCountry, colCountry, pickedSlice]);

  if (metaError) return <div className="error-box">{metaError}</div>;
  if (!meta) return <p className="muted">正在读取 OECD ICIO 原始文件索引…</p>;

  const selectedFile = meta.files.find((f) => f.year === year);
  const pages = slice ? Math.max(1, Math.ceil(slice.total / slice.page_size)) : 1;
  const colOptions = table === "y" ? meta.final_demand_categories : meta.sectors;
  const activeTable = DB_TABLES.find((t) => t.key === table)!;
  const dataColumns = (slice?.columns ?? []).filter((column) => column !== "row");
  const rowHeatMax = (slice?.rows ?? []).map((row) =>
    Math.max(...dataColumns.map((column) => Math.abs(typeof row[column] === "number" ? row[column] : 0)), 0));
  const columnTotals = Object.fromEntries(dataColumns.map((column) => [
    column,
    (slice?.rows ?? []).reduce((sum, row) => sum + (typeof row[column] === "number" ? row[column] : 0), 0),
  ]));
  const showSummaries = table !== "accounts" && Boolean(slice?.row_summaries?.length);
  const selectedObservation = state.data?.observation;

  if (!meta.years.length) {
    return (
      <div>
        <div className="warnbox">
          课程原始数据尚未准备好。请刷新重试；仍未恢复时联系教师。
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="db-summary">
        <span>原始年份 {meta.years[0]}–{meta.years.at(-1)}</span>
        <span>{economyAccountCoverageLabel(meta.countries)}</span>
        <span>{meta.sectors.length} 个行业</span>
        <span>{meta.n_rows.toLocaleString("zh-CN")} 行 × {meta.n_columns.toLocaleString("zh-CN")} 列</span>
        {selectedFile && <span>{selectedFile.file}</span>}
      </div>

      <DatabaseGuide meta={meta} />

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
        <LabeledControl label="供给方经济体（行）">
          {(id) => (
            <select id={id} value={rowCountry} onChange={(e) => pickRowCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="供给行业（行）">
          {(id) => (
            <select id={id} value={rowSector} onChange={(e) => pickRowSector(e.target.value)}>
              <option value="">全部</option>
              {meta.sectors.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
            </select>
          )}
        </LabeledControl>
        {table !== "accounts" && (
          <>
            <LabeledControl label={table === "y" ? "目的经济体（列）" : "使用方经济体（列）"}>
              {(id) => (
                <select id={id} value={colCountry} onChange={(e) => pickColCountry(e.target.value)}>
                  {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
                </select>
              )}
            </LabeledControl>
            <LabeledControl label={table === "y" ? "最终需求（列）" : "使用行业（列）"}>
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
          {slice ? `共 ${slice.total} 行` : sliceStatus === "error" ? "加载失败" : "加载中…"}
        </span>
      </div>

      {sliceError && (
        <div className="error-box async-error" role="alert" style={{ marginBottom: 14 }}>
          <span>{userFacingRequestError(sliceError, "筛选结果加载失败")}</span>
          <button type="button" className="secondary" onClick={retrySlice}>重试</button>
        </div>
      )}
      <div className="tipbox" style={{ marginBottom: 10 }}>
        <b>怎么读这张表：</b>{HOW_TO_READ[table]}
      </div>
      <div className="tipbox" style={{ marginBottom: 10 }}>
        <b>记录一个观察值：</b>点击任意数值单元格，系统会自动保存它的行、列与数值，并在实验报告中作为可选实验快照展示。
      </div>
      <ScrollableRegion className="table-wrap bounded-data-table" label={`${activeTable.label}数据表，可横向滚动`}>
        <table className="data-table db-table">
          <thead>
            <tr>
              {(slice?.columns ?? ["row"]).map((c, index) => (
                <th
                  key={c}
                  title={c === "row" ? ROW_HEADER[table].title : columnHelp(c)}
                  style={index === 0 ? { position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" } : undefined}
                >
                  {/* 首列原样输出后端的 "row",学生看到的就是个英文字段名;这里换成
                      说明它是什么方向的中文表头,与上方筛选器的「(行)」对应。 */}
                  {c === "row" ? `${ROW_HEADER[table].label} ⓘ` : `${c}${columnHelp(c) ? " ⓘ" : ""}`}
                </th>
              ))}
              {showSummaries && <th title="当前筛选列在该行的合计">切片合计</th>}
              {showSummaries && <th title={ACCOUNT_HELP.OUT}>对应 OUT ⓘ</th>}
            </tr>
          </thead>
          <tbody>
            {(slice?.rows ?? []).map((r, i) => (
              <tr key={`${r.row ?? "row"}-${i}`}>
                {(slice?.columns ?? []).map((c, columnIndex) => {
                  const value = r[c];
                  const numericValue = typeof value === "number" ? value : null;
                  const rowLabel = String(r.row ?? "");
                  const selected = numericValue != null
                    && selectedObservation?.row === rowLabel
                    && selectedObservation.column === c
                    && selectedObservation.value === numericValue;
                  const intensity = c === "row" || numericValue == null || rowHeatMax[i] === 0
                    ? 0
                    : Math.min(1, Math.abs(numericValue) / rowHeatMax[i]);
                  return (
                    <td
                      key={c}
                      title={columnHelp(c) ?? (typeof value === "number" ? `${c}: ${fmtDb(value)}` : undefined)}
                      style={columnIndex === 0
                        ? { position: "sticky", left: 0, zIndex: 2, background: "#fff", textAlign: "left" }
                        : intensity > 0
                          ? { background: numericValue != null && numericValue < 0 ? `rgba(227,73,72,${0.06 + intensity * 0.24})` : `rgba(42,120,214,${0.05 + intensity * 0.25})` }
                          : undefined}
                    >
                      {c === "row" || numericValue == null ? String(value ?? "—") : (
                        <button
                          type="button"
                          className={`db-observation-cell${selected ? " selected" : ""}`}
                          aria-pressed={selected}
                          title={`${rowLabel} × ${c}: ${fmtDb(numericValue)}；点击记录这个观察值`}
                          onClick={() => {
                            if (!slice) return;
                            state.save(captureDbObservation(
                              {
                                year: slice.year,
                                table,
                                rowCountry,
                                colCountry,
                                rowSector,
                                colSector,
                              },
                              { row: rowLabel, column: c, value: numericValue },
                            ));
                          }}
                        >
                          {fmtDb(numericValue)}{selected ? " ✓" : ""}
                        </button>
                      )}
                    </td>
                  );
                })}
                {showSummaries && <td>{fmtDb(slice?.row_summaries?.[i]?.slice_total ?? null)}</td>}
                {showSummaries && <td>{fmtDb(slice?.row_summaries?.[i]?.out ?? null)}</td>}
              </tr>
            ))}
            {slice && slice.rows.length === 0 && (
              <tr><td colSpan={slice.columns.length || 1}>无匹配记录</td></tr>
            )}
          </tbody>
          {slice && slice.rows.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700, background: "#f7f8fb" }}>
                <td style={{ position: "sticky", left: 0, zIndex: 2, background: "#f7f8fb", textAlign: "left" }}>本页列合计</td>
                {dataColumns.map((column) => <td key={column}>{fmtDb(columnTotals[column])}</td>)}
                {showSummaries && <td>{fmtDb((slice.row_summaries ?? []).reduce((sum, item) => sum + item.slice_total, 0))}</td>}
                {showSummaries && <td>—</td>}
              </tr>
            </tfoot>
          )}
        </table>
      </ScrollableRegion>
      {table !== "accounts" && slice && (
        <div className="tipbox" style={{ marginTop: 12 }}>
          每个数据行同时给出当前筛选列合计与该经济体×行业的总产出（OUT）。完整口径下，OUT = Z 行和 + Y 行和；当前筛选结果只展示部分列，差额来自未展示的目的经济体或需求类别。
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Pager page={page} pages={pages} total={slice?.total} onChange={setPage} />
      </div>
      <div className="observation-strip" aria-live="polite">
        <b>已记录的原始数据点</b>
        {selectedObservation ? (
          <span>{selectedObservation.row} × {selectedObservation.column} = {fmtDb(selectedObservation.value)}</span>
        ) : <span>尚未选择</span>}
      </div>
    </div>
  );
}
