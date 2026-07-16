import { useEffect, useState } from "react";
import { api } from "../../api";
import type { DbMeta, DbSlice, DbTableKind, StepEvidenceApi } from "../../types";
import { EvidencePanel } from "../../step-evidence";
import { countryLabel, sectorLabel } from "../../viz";
import { fmtDb, Pager, useAsync } from "../shared";

const DB_TABLES: { key: DbTableKind; label: string; hint: string }[] = [
  { key: "z", label: "中间投入 Z", hint: "国家-行业 × 国家-行业" },
  { key: "y", label: "最终需求 Y", hint: "国家-行业 × 目的国需求类别" },
  { key: "accounts", label: "账户项", hint: "TLS / VA / OUT 转置为国家-行业行" },
];

const ACCOUNT_HELP: Record<string, string> = {
  TLS: "产品税减补贴。为负表示该账户合计为净补贴；步骤4 的 taxsub 是其沿投入产出链传导后的出口含量。",
  VA: "增加值：劳动报酬、资本回报等本地创造的价值，是步骤5生产活动分解的总来源。",
  OUT: "总产出。按行看应等于中间使用 Z 的行和加最终需求 Y 的行和，步骤3会检验这条会计恒等式。",
};

/** OECD ICIO 最终需求类别缩写 → 中文名(Y 表列名形如 USA_HFCE:目的国_需求类别) */
const FD_HELP: Record<string, string> = {
  HFCE: "居民最终消费支出",
  NPISH: "为居民服务的非营利机构消费",
  GGFC: "政府最终消费支出",
  GFCF: "固定资本形成总额(投资)",
  INVNT: "存货变化",
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

/** 步骤1:本地 OECD ICIO 原始表浏览 */
/** 第 1 步的学习证据:真正取回了一个有效切片。 */
interface DbEvidence extends Record<string, unknown> {
  slice?: { year: number; table: string; row_country: string; col_country: string };
}

export function DbLab({ evidence }: { evidence: StepEvidenceApi<DbEvidence> }) {
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

  // 本步的证据必须是学生**主动选定**的切片。页面自带默认切片(CHN×USA×最新年)
  // 并会自动载入,如果照单记为证据,那就等于“打开这一步就算完成”——正是要消灭的东西。
  const [pickedSlice, setPickedSlice] = useState(false);

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
  const { data: slice, error: sliceError } = useAsync<DbSlice | null>(
    () => (ready && year
      ? api.dbSlice({
        year,
        table,
        rowCountry,
        colCountry: table === "accounts" ? undefined : colCountry,
        rowSector,
        colSector: table === "accounts" ? undefined : colSector,
        page,
        pageSize: 25,
      })
      : Promise.resolve(null)),
    [ready, year, table, rowCountry, colCountry, rowSector, colSector, page],
  );

  // 证据要的是“学生自己选定的切片、并且真的取回了数据”:
  // 因此既要有主动选择(pickedSlice),又要等切片加载成功。
  useEffect(() => {
    if (!slice || !year || !pickedSlice) return;
    evidence.save({
      slice: { year, table, row_country: rowCountry, col_country: table === "accounts" ? "" : colCountry },
    });
    // evidence 每次渲染都是新对象,不入依赖;切片本身变化即代表证据变化。
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
      <EvidencePanel evidence={evidence} title="本步要留下的证据:自己选定并载入一个切片(页面默认的切片不算)" />
      <div className="db-summary">
        <span>原始年份 {meta.years[0]}-{meta.years.at(-1)}</span>
        <span>{meta.countries.length} 个经济体</span>
        <span>{meta.sectors.length} 个行业</span>
        <span>{meta.n_rows.toLocaleString("zh-CN")} 行 × {meta.n_columns.toLocaleString("zh-CN")} 列</span>
        {selectedFile && <span>{selectedFile.file}</span>}
      </div>

      <div className="controls">
        <label>年份</label>
        <select value={year ?? ""} onChange={(e) => pickYear(Number(e.target.value))}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
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
        <label>行国家</label>
        <select value={rowCountry} onChange={(e) => pickRowCountry(e.target.value)}>
          {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
        </select>
        <label>行行业</label>
        <select value={rowSector} onChange={(e) => pickRowSector(e.target.value)}>
          <option value="">全部</option>
          {meta.sectors.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
        </select>
        {table !== "accounts" && (
          <>
            <label>列国家</label>
            <select value={colCountry} onChange={(e) => pickColCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
            <label>{table === "y" ? "最终需求" : "列行业"}</label>
            <select value={colSector} onChange={(e) => pickColSector(e.target.value)}>
              <option value="">全部</option>
              {colOptions.map((s) => (
                <option key={s} value={s}>{table === "y" ? (FD_HELP[s] ? `${s} ${FD_HELP[s]}` : s) : sectorLabel(s)}</option>
              ))}
            </select>
          </>
        )}
        <span className="muted">{slice ? `共 ${slice.total} 行` : "加载中…"}</span>
      </div>

      {sliceError && <div className="error-box" style={{ marginBottom: 14 }}>{sliceError}</div>}
      <div className="table-wrap">
        <table className="data-table db-table">
          <thead>
            <tr>
              {(slice?.columns ?? ["row"]).map((c, index) => (
                <th
                  key={c}
                  title={columnHelp(c)}
                  style={index === 0 ? { position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" } : undefined}
                >
                  {c}{columnHelp(c) ? " ⓘ" : ""}
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
                      {c === "row" ? String(value ?? "—") : fmtDb(value)}
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
      </div>
      {table !== "accounts" && slice && (
        <div className="tipbox" style={{ marginTop: 12 }}>
          每个数据行同时给出当前切片合计与该国家–行业的 OUT。完整口径下，OUT = Z 行和 + Y 行和；当前切片只是一部分，差额来自未展示的目的国或需求列。
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Pager page={page} pages={pages} total={slice?.total} onChange={setPage} />
      </div>
    </div>
  );
}
