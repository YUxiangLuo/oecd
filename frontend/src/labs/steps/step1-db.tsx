import { useEffect, useState } from "react";
import { api } from "../../api";
import type { DbMeta, DbSlice, DbTableKind } from "../../types";
import { fmtDb, useAsync } from "../shared";

const DB_SOURCES = [
  {
    name: "OECD ICIO",
    org: "经济合作与发展组织 OECD",
    scope: "76+1",
    industries: "45",
    years: "1995-2020",
    url: "https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html",
    status: "唯一真实计算数据源",
  },
  {
    name: "OECD-AMNE",
    org: "经济合作与发展组织 OECD",
    scope: "76+1",
    industries: "41",
    years: "2000-2020",
    url: "https://www.oecd.org/en/data/datasets/multinational-enterprises-and-global-value-chains.html",
    status: "教学比较",
  },
  {
    name: "ADB-MRIO",
    org: "亚洲开发银行 ADB",
    scope: "62+1 / 72+1",
    industries: "35",
    years: "2007-2023",
    url: "https://kidb.adb.org/globalization",
    status: "教学比较",
  },
  {
    name: "WIOD",
    org: "荷兰格罗宁根大学",
    scope: "43+1",
    industries: "56",
    years: "2000-2014",
    url: "https://www.rug.nl/ggdc/valuechain/wiod/",
    status: "教学比较",
  },
  {
    name: "Eora MRIO",
    org: "澳大利亚研究委员会 ARC 支持",
    scope: "190",
    industries: "26",
    years: "1990-2022",
    url: "https://worldmrio.com/",
    status: "教学比较",
  },
  {
    name: "GTAP-11",
    org: "美国普渡大学 GTAP",
    scope: "141+19",
    industries: "65",
    years: "2004/2007/2011/2014/2017",
    url: "https://www.gtap.agecon.purdue.edu/",
    status: "教学比较",
  },
];

const DB_TABLES: { key: DbTableKind; label: string; hint: string }[] = [
  { key: "z", label: "中间投入 Z", hint: "国家-行业 × 国家-行业" },
  { key: "y", label: "最终需求 Y", hint: "国家-行业 × 目的国需求类别" },
  { key: "accounts", label: "账户项", hint: "TLS / VA / OUT 转置为国家-行业行" },
];

function DatabaseComparison() {
  return (
    <div className="table-wrap" style={{ marginBottom: 16 }}>
      <table className="data-table db-table">
        <thead>
          <tr>
            <th>投入产出数据库</th>
            <th>数据库建立机构</th>
            <th>国家或地区数量</th>
            <th>行业或部门数量</th>
            <th>时间维度</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {DB_SOURCES.map((source) => (
            <tr key={source.name} className={source.name === "OECD ICIO" ? "active-row" : ""}>
              <td><a href={source.url} target="_blank" rel="noreferrer">{source.name}</a></td>
              <td>{source.org}</td>
              <td>{source.scope}</td>
              <td>{source.industries}</td>
              <td>{source.years}</td>
              <td>{source.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 步骤1:数据库介绍 + OECD ICIO 原始表浏览 */
export function DbLab() {
  const { data: meta, error: metaError } = useAsync<DbMeta>(() => api.dbMeta(), []);
  const [table, setTable] = useState<DbTableKind>("z");
  const [year, setYear] = useState<number | null>(null);
  const [rowCountry, setRowCountry] = useState("");
  const [colCountry, setColCountry] = useState("");
  const [rowIndustry, setRowIndustry] = useState("");
  const [colIndustry, setColIndustry] = useState("");
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
  const pickRowIndustry = withPageReset(setRowIndustry);
  const pickColIndustry = withPageReset(setColIndustry);

  const ready = Boolean(meta && year && rowCountry && (table === "accounts" || colCountry));
  const { data: slice, error: sliceError } = useAsync<DbSlice | null>(
    () => (ready && year
      ? api.dbSlice({
        year,
        table,
        rowCountry,
        colCountry: table === "accounts" ? undefined : colCountry,
        rowIndustry,
        colIndustry: table === "accounts" ? undefined : colIndustry,
        page,
        pageSize: 25,
      })
      : Promise.resolve(null)),
    [ready, year, table, rowCountry, colCountry, rowIndustry, colIndustry, page],
  );

  if (metaError) return <div className="error-box">{metaError}</div>;
  if (!meta) return <p className="muted">正在读取 OECD ICIO 原始文件索引…</p>;

  const selectedFile = meta.files.find((f) => f.year === year);
  const pages = slice ? Math.max(1, Math.ceil(slice.total / slice.page_size)) : 1;
  const colOptions = table === "y" ? meta.final_demand_categories : meta.industries;
  const activeTable = DB_TABLES.find((t) => t.key === table)!;

  if (!meta.years.length) {
    return (
      <div>
        <DatabaseComparison />
        <div className="warnbox">
          未找到本地 OECD ICIO 原始 CSV。请将 ICIO2023_YYYY.csv 放入 OECD_ICIO/ 后刷新本页。
        </div>
      </div>
    );
  }

  return (
    <div>
      <DatabaseComparison />

      <div className="db-summary">
        <span>原始年份 {meta.years[0]}-{meta.years.at(-1)}</span>
        <span>{meta.countries.length} 个经济体</span>
        <span>{meta.industries.length} 个行业</span>
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
                setColIndustry("");
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
        <select value={rowIndustry} onChange={(e) => pickRowIndustry(e.target.value)}>
          <option value="">全部</option>
          {meta.industries.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {table !== "accounts" && (
          <>
            <label>列国家</label>
            <select value={colCountry} onChange={(e) => pickColCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label>{table === "y" ? "最终需求" : "列行业"}</label>
            <select value={colIndustry} onChange={(e) => pickColIndustry(e.target.value)}>
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
            <tr>{(slice?.columns ?? ["row"]).map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {(slice?.rows ?? []).map((r, i) => (
              <tr key={`${r.row ?? "row"}-${i}`}>
                {(slice?.columns ?? []).map((c) => (
                  <td key={c}>{c === "row" ? String(r[c] ?? "—") : fmtDb(r[c])}</td>
                ))}
              </tr>
            ))}
            {slice && slice.rows.length === 0 && (
              <tr><td colSpan={slice.columns.length || 1}>无匹配记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>← 上一页</button>
        <span>{page} / {pages}{slice ? ` · 共 ${slice.total} 行` : ""}</span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页 →</button>
      </div>
    </div>
  );
}
