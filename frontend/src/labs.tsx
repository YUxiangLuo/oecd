/**
 * 各步骤的"动手实验"面板。
 * 当前为最小可用版:真实数据表格 + 回归运行 + 报告预览;
 * 网络图/堆叠条形图等富可视化见 prototype/ 原型,列入路线图。
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import type {
  DbMeta, DbSlice, DbTableKind, IndicatorSchema, Meta, NetworkData, QcCheck,
  SectorPage, ShockEvent, ShockSummary, Step,
} from "./types";
import { HeatTableViz, LengthViz, NetworkViz, StackedShareViz } from "./viz";

function fmtField(v: string | number | null, key: string, schema?: IndicatorSchema | null) {
  if (typeof v !== "number") return v ?? "—";
  const format = schema?.fields[key]?.format;
  if (format === "pct") return `${(v * 100).toFixed(2)}%`;
  if (format === "amount") return v.toFixed(2);
  return v.toFixed(3);
}

function fieldLabel(key: string, schema?: IndicatorSchema | null) {
  return schema?.fields[key]?.label ?? key;
}

const fmtDb = (v: string | number | null) => {
  if (typeof v !== "number") return v ?? "—";
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 });
};

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fn().then(
      (d) => live && setData(d),
      (e) => live && setError(String(e.message ?? e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

const DB_SOURCES = [
  {
    name: "OECD ICIO",
    status: "已接入",
    detail: "当前项目主数据库,支持中间投入、最终需求、TLS/VA/OUT 账户表浏览。",
  },
  {
    name: "WIOD",
    status: "备选",
    detail: "行业口径更细但年份覆盖不同,可作为稳健性扩展。",
  },
  {
    name: "Eora MRIO",
    status: "备选",
    detail: "国家覆盖更广,适合全球网络扩展但许可和口径成本更高。",
  },
  {
    name: "中国国家统计局",
    status: "补充",
    detail: "适合国内分区域或投入产出表校准,不能直接替代全球 MRIO。",
  },
];

const DB_TABLES: { key: DbTableKind; label: string; hint: string }[] = [
  { key: "z", label: "中间投入 Z", hint: "国家-行业 × 国家-行业" },
  { key: "y", label: "最终需求 Y", hint: "国家-行业 × 目的国需求类别" },
  { key: "accounts", label: "账户项", hint: "TLS / VA / OUT 转置为国家-行业行" },
];

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

  if (!meta.years.length) {
    return (
      <div>
        <div className="db-source-grid">
          {DB_SOURCES.map((source) => (
            <div key={source.name} className={`db-source${source.name === "OECD ICIO" ? " active" : ""}`}>
              <div className="db-source-head">
                <strong>{source.name}</strong>
                <span>{source.status}</span>
              </div>
              <p>{source.detail}</p>
            </div>
          ))}
        </div>
        <div className="warnbox">
          未找到本地 OECD ICIO 原始 CSV。请将 ICIO2023_YYYY.csv 放入 OECD_ICIO/ 后刷新本页。
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="db-source-grid">
        {DB_SOURCES.map((source) => (
          <div key={source.name} className={`db-source${source.name === "OECD ICIO" ? " active" : ""}`}>
            <div className="db-source-head">
              <strong>{source.name}</strong>
              <span>{source.status}</span>
            </div>
            <p>{source.detail}</p>
          </div>
        ))}
      </div>

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

export function QcLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const { data, error } = useAsync<QcCheck[]>(() => api.qc(year), [year]);
  if (error) return <div className="error-box">{error}</div>;
  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>质检项</th><th>类型</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>{c.kind}</td>
                <td className={c.passed ? "qc-pass" : "qc-fail"}>{c.passed ? "✓ 通过" : "✗ 异常"}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {c.detail}
                  {c.warnings.map((w) => (
                    <div key={w} className="muted">⚠ {w}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function YearPicker({ years, year, onChange }: { years: number[]; year: number; onChange: (y: number) => void }) {
  return (
    <div className="controls">
      <label>年份</label>
      <select value={year} onChange={(e) => onChange(Number(e.target.value))}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** 步骤2:政策冲击数据 —— 事件时间线 + 覆盖概览 + 面板浏览 */
export function ShockLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1) ?? 2020);
  const [country, setCountry] = useState("");
  const [sector, setSector] = useState("");
  const [onlyHit, setOnlyHit] = useState(true);
  const [page, setPage] = useState(1);

  const { data: events, error: evErr } = useAsync(() => api.shockEvents(), []);
  const { data: summary } = useAsync<ShockSummary>(() => api.shockSummary(), []);
  const { data: panel, error: panelErr } = useAsync<SectorPage>(
    () => api.shockPanel(year, country, sector, onlyHit, page),
    [year, country, sector, onlyHit, page],
  );

  const summaryYear = summary?.years.find((r) => r.year === year);
  const pages = panel ? Math.max(1, Math.ceil(panel.total / panel.page_size)) : 1;

  return (
    <div>
      <div className="warnbox">
        ⚠ 拟真演示数据:以 2018–2020 全球贸易摩擦真实事件为原型手工编码(税率量级参考
        PIIE/Bown),乘以风格化出口暴露度;覆盖 {summary ? `${summary.n_countries} 个经济体 × ${summary.n_sectors} 个行业` : "全部经济体与行业"},不能用于研究结论。
      </div>

      <h3 style={{ margin: "18px 0 10px", fontSize: 15 }}>事件时间线</h3>
      {evErr && <div className="error-box">{evErr}</div>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th style={{ textAlign: "left" }}>事件</th><th>加征方 → 目标</th><th>宣布</th><th>生效</th><th>涉及行业</th><th>峰值行业税率</th></tr>
          </thead>
          <tbody>
            {(events?.events ?? []).map((e: ShockEvent) => (
              <tr key={e.name}>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>{e.name}</td>
                <td>{e.imposer} → {e.targets}{e.exempt ? `(豁免:${e.exempt})` : ""}</td>
                <td>{e.announced}</td>
                <td>{e.effective}</td>
                <td>{e.n_sectors} 个(主要:{e.top_sectors.join("、")})</td>
                <td>{pct(e.peak_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: "22px 0 10px", fontSize: 15 }}>冲击面板浏览</h3>
      <div className="controls">
        <label>年份</label>
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setPage(1); }}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <label>国家</label>
        <select value={country} onChange={(e) => { setCountry(e.target.value); setPage(1); }}>
          <option value="">全部</option>
          {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label>行业</label>
        <select value={sector} onChange={(e) => { setSector(e.target.value); setPage(1); }}>
          <option value="">全部</option>
          {meta.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <input type="checkbox" checked={onlyHit}
            onChange={(e) => { setOnlyHit(e.target.checked); setPage(1); }} />
          只看受冲击
        </label>
        {summaryYear && (
          <span className="muted">
            {year} 年:{summaryYear.treated_countries} 个经济体、{summaryYear.treated_pairs} 个国家–行业受冲击
            {summaryYear.max_shock > 0 &&
              `,最高 ${pct(summaryYear.max_shock)}(${summaryYear.max_shock_target})`}
          </span>
        )}
      </div>
      {panelErr && <div className="error-box">{panelErr}</div>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th style={{ textAlign: "left" }}>国家</th><th>行业</th><th>平均额外关税</th><th>受处理</th><th>宣布</th><th>生效</th><th style={{ textAlign: "left" }}>主要事件</th></tr>
          </thead>
          <tbody>
            {(panel?.rows ?? []).map((r, i) => (
              <tr key={i}>
                <td style={{ textAlign: "left" }}>{String(r.country)}</td>
                <td>{String(r.sector)}</td>
                <td>{typeof r.tariff_shock === "number" ? pct(r.tariff_shock) : "—"}</td>
                <td>{r.treated === 1 ? "✓" : ""}</td>
                <td>{r.announced_date ?? "—"}</td>
                <td>{r.effective_date ?? "—"}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>{r.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>← 上一页</button>
        <span>{page} / {pages}{panel ? ` · 共 ${panel.total} 条` : ""}</span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页 →</button>
      </div>
    </div>
  );
}

const STEP_GROUP: Record<number, string> = {
  4: "trade",
  5: "production",
  6: "length",
  7: "network",
};

/** 步骤4-7:行业级指标数据表(分页 + 国家/年份筛选) */
export function IndicatorLab({ meta, step }: { meta: Meta; step: Step }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState("CHN");
  const [page, setPage] = useState(1);
  const groupKey = STEP_GROUP[step.n] ?? "trade";
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);
  const { data, error } = useAsync<SectorPage>(
    () => api.sectorIndicators(year, country, page),
    [year, country, page],
  );
  if (error) return <div className="error-box">{error}</div>;
  const group = schema?.groups.find((g) => g.key === groupKey);
  const baseCols = ["year", "country", "sector"];
  const rowKeys = data?.rows[0] ? new Set(Object.keys(data.rows[0])) : new Set<string>();
  const cols = data?.rows[0]
    ? [...baseCols, ...(group?.fields ?? []).filter((c) => rowKeys.has(c))]
    : [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div>
      <div className="controls">
        <label>国家</label>
        <select value={country} onChange={(e) => { setCountry(e.target.value); setPage(1); }}>
          <option value="">全部</option>
          {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label>年份</label>
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setPage(1); }}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="muted">{data ? `共 ${data.total} 条` : "加载中…"}</span>
      </div>
      {group && (
        <div className="tipbox">
          {group.label}:按 {country || "全部经济体"} · {year} 年展示国家–行业级完整分解字段。
        </div>
      )}
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>{cols.map((c) => <th key={c}>{fieldLabel(c, schema)}</th>)}</tr></thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={i}>{cols.map((c) => (
                <td key={c}>{["year", "country", "sector"].includes(c) ? String(r[c] ?? "—") : fmtField(r[c], c, schema)}</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>← 上一页</button>
        <span>{page} / {pages}</span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页 →</button>
      </div>
    </div>
  );
}

/** 步骤8-11:富可视化(网络图/堆叠条/长度条/热力表),每个图都有表格视图孪生 */
export function VizLab({ meta, step, columns }: { meta: Meta; step: Step; columns: string[] }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [view, setView] = useState<"chart" | "table">("chart");
  const isNetwork = step.n === 8;
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);
  const { data: rows, error } = useAsync(
    () => api.countryIndicators(year),
    [year],
  );
  const { data: net, error: netErr } = useAsync<NetworkData | null>(
    () => (isNetwork ? api.network(year) : Promise.resolve(null)),
    [year, isNetwork],
  );
  if (error || netErr) return <div className="error-box">{error ?? netErr}</div>;

  const sortCol = columns[0];
  const tableRows = (rows ?? [])
    .slice()
    .sort((a, b) => Number(b[sortCol] ?? 0) - Number(a[sortCol] ?? 0))
    .slice(0, 15);

  const chart = () => {
    if (isNetwork) return net ? <NetworkViz data={net} /> : <p className="muted">加载中…</p>;
    if (!rows) return <p className="muted">加载中…</p>;
    if (step.n === 9) return <StackedShareViz rows={rows} />;
    if (step.n === 10) return <LengthViz rows={rows} />;
    return <HeatTableViz rows={rows} />;
  };

  return (
    <div>
      <div className="controls">
        <label>年份</label>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="seg">
          <button className={view === "chart" ? "on" : ""} onClick={() => setView("chart")}>图表</button>
          <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>表格</button>
        </div>
      </div>
      {view === "chart" ? chart() : (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>国家</th>{columns.map((c) => <th key={c}>{fieldLabel(c, schema)}</th>)}</tr></thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={String(r.country)}>
                  <td>{String(r.country)}</td>
                  {columns.map((c) => <td key={c}>{fmtField(r[c], c, schema)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 步骤17:实验报告 */
export function ReportLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const { data, error } = useAsync(() => api.report(year), [year]);
  if (error) return <div className="error-box">{error}</div>;
  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
      {data ? (
        <>
          <p className="muted">已写入 {data.path}(Markdown 源文件,可用 pandoc 转 PDF)</p>
          <div className="report-md">{data.markdown}</div>
        </>
      ) : (
        <p className="muted">正在生成报告…</p>
      )}
    </div>
  );
}
