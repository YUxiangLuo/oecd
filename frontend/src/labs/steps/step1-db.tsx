import { useEffect, useState } from "react";
import { api } from "../../api";
import type { DbMeta, DbSlice, DbTableKind } from "../../types";
import { fmtDb, Pager, useAsync } from "../shared";

/** 国际主流投入产出数据库对比(客户资料《1、国际主流投入产出数据库的展示与说明》) */
const DB_COMPARISON = [
  { name: "OECD-ICIO", org: "经济合作与发展组织 OECD", countries: "76+1", sectors: 45, years: "1995–2020", url: "https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html", note: "常规版+扩展版(中墨区分加工贸易);本系统主数据源" },
  { name: "OECD-AMNE", org: "经济合作与发展组织 OECD", countries: "76+1", sectors: 41, years: "2000–2020", url: "https://www.oecd.org/en/data/datasets/multinational-enterprises-and-global-value-chains.html", note: "区分内、外资企业属性的跨国企业活动数据库" },
  { name: "ADB-MRIO", org: "亚洲开发银行 ADB", countries: "62+1", sectors: 35, years: "2007–2023", url: "https://kidb.adb.org/globalization", note: "重点覆盖亚太经济体,数据时间维度较新" },
  { name: "WIOD-2013", org: "格罗宁根大学(荷兰)", countries: "40+1", sectors: 35, years: "1995–2011", url: "https://www.rug.nl/ggdc/valuechain/wiod/?lang=en", note: "附带环境账户,适合贸易与碳足迹研究" },
  { name: "WIOD-2016", org: "格罗宁根大学(荷兰)", countries: "43+1", sectors: 56, years: "2000–2014", url: "https://www.rug.nl/ggdc/valuechain/wiod/?lang=en", note: "行业分类最细(56 个)" },
  { name: "Eora MRIO", org: "澳大利亚研究委员会 ARC 资助", countries: "190", sectors: 26, years: "1990–2022", url: "https://worldmrio.com/", note: "国家覆盖最广,常用于可持续发展与碳核算" },
  { name: "GTAP-11", org: "美国普渡大学 GTAP", countries: "141+19", sectors: 65, years: "2004/2007/2011/2014/2017", url: "https://www.gtap.agecon.purdue.edu/databases/default.asp", note: "非连续年份,主要用于政策模拟与经济建模" },
];

function DbComparisonTable() {
  return (
    <div className="table-wrap" style={{ marginBottom: 18 }}>
      <table className="data-table">
        <thead>
          <tr><th>数据库</th><th>建立机构</th><th>国家/地区</th><th>行业数</th><th>时间维度</th><th>特点</th></tr>
        </thead>
        <tbody>
          {DB_COMPARISON.map((db) => (
            <tr key={db.name} style={db.name === "OECD-ICIO" ? { background: "#f4f3ff", fontWeight: 600 } : undefined}>
              <td><a href={db.url} target="_blank" rel="noreferrer">{db.name}</a>{db.name === "OECD-ICIO" ? " ✓" : ""}</td>
              <td>{db.org}</td>
              <td>{db.countries}</td>
              <td>{db.sectors}</td>
              <td>{db.years}</td>
              <td style={{ fontWeight: 400 }}>{db.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 11.5, margin: "8px 2px 0" }}>
        本系统选用 OECD-ICIO:77 经济体 × 45 行业、1995–2020 连续年份、官方免费,且提供 TLS/VA/OUT 账户项,
        能同时支撑贸易流分解(税收项)、生产分解、长度与网络指标计算。("+1" = 世界其他地区 ROW 聚合账户)
      </p>
    </div>
  );
}

const DB_TABLES: { key: DbTableKind; label: string; hint: string }[] = [
  { key: "z", label: "中间投入 Z", hint: "国家-行业 × 国家-行业" },
  { key: "y", label: "最终需求 Y", hint: "国家-行业 × 目的国需求类别" },
  { key: "accounts", label: "账户项", hint: "TLS / VA / OUT 转置为国家-行业行" },
];

const ACCOUNT_HELP: Record<string, string> = {
  TLS: "产品税减补贴。为负表示补贴超过产品税；步骤4 的 taxsub 正是沿投入产出链传导后的 TLS 含量。",
  VA: "增加值：劳动报酬、资本回报等本地创造的价值，是步骤5生产活动分解的总来源。",
  OUT: "总产出。按行看应等于中间使用 Z 的行和加最终需求 Y 的行和，步骤3会检验这条会计恒等式。",
};

/** 步骤1:数据库介绍 + OECD ICIO 原始表浏览 */
export function DbLab() {
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

  // 换筛选条件时在事件里直接回到第 1 页,避免先用旧页码发一次多余请求
  const withPageReset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
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
        <DbComparisonTable />
        <div className="warnbox">
          未找到本地 OECD ICIO 原始 CSV。请将 ICIO2023_YYYY.csv 放入 OECD_ICIO/ 后刷新本页。
        </div>
      </div>
    );
  }

  return (
    <div>
      <DbComparisonTable />

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
          {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label>行行业</label>
        <select value={rowSector} onChange={(e) => pickRowSector(e.target.value)}>
          <option value="">全部</option>
          {meta.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {table !== "accounts" && (
          <>
            <label>列国家</label>
            <select value={colCountry} onChange={(e) => pickColCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label>{table === "y" ? "最终需求" : "列行业"}</label>
            <select value={colSector} onChange={(e) => pickColSector(e.target.value)}>
              <option value="">全部</option>
              {colOptions.map((s) => <option key={s} value={s}>{s}</option>)}
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
                  title={ACCOUNT_HELP[c]}
                  style={index === 0 ? { position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" } : undefined}
                >
                  {c}{ACCOUNT_HELP[c] ? " ⓘ" : ""}
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
                      title={ACCOUNT_HELP[c] ?? (typeof value === "number" ? `${c}: ${fmtDb(value)}` : undefined)}
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
