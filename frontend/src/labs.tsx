/**
 * 各步骤的"动手实验"面板。
 * 当前为最小可用版:真实数据表格 + 回归运行 + 报告预览;
 * 网络图/堆叠条形图等富可视化见 prototype/ 原型,列入路线图。
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import type {
  Meta, QcCheck, RegressionResponse, SectorPage, ShockEvent, ShockSummary, Step,
} from "./types";

const fmt = (v: string | number | null, digits = 3) =>
  typeof v === "number" ? v.toFixed(digits) : (v ?? "—");

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
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

/** 步骤4-7:行业级指标数据表(分页 + 国家/年份筛选) */
export function IndicatorLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState("CHN");
  const [page, setPage] = useState(1);
  const { data, error } = useAsync<SectorPage>(
    () => api.sectorIndicators(year, country, page),
    [year, country, page],
  );
  if (error) return <div className="error-box">{error}</div>;
  const cols = data?.rows[0] ? Object.keys(data.rows[0]) : [];
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
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {(data?.rows ?? []).map((r, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}>{typeof r[c] === "number" && !["year"].includes(c) ? fmt(r[c]) : String(r[c] ?? "—")}</td>)}</tr>
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

/** 步骤8-11:可视化(最小版 —— 国家级指标排序表,富图表见路线图) */
export function VizLab({ meta, columns }: { meta: Meta; columns: string[] }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const { data, error } = useAsync(() => api.countryIndicators(year), [year]);
  if (error) return <div className="error-box">{error}</div>;
  const sortCol = columns[0];
  const rows = (data ?? [])
    .slice()
    .sort((a, b) => Number(b[sortCol] ?? 0) - Number(a[sortCol] ?? 0))
    .slice(0, 15);
  return (
    <div>
      <div className="tipbox">
        最小版可视化:按 <b>{sortCol}</b> 排序的 Top 15 国家。交互式网络图/堆叠条形图对应 prototype/ 原型,见 README 路线图。
      </div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>国家</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.country)}>
                <td>{String(r.country)}</td>
                {columns.map((c) => <td key={c}>{fmt(r[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 步骤12-16:回归设计与运行 */
export function RegressionLab({ step }: { step: Step }) {
  const regStep = step.n === 12 ? 13 : step.n;
  const [granularity, setGranularity] = useState("国家–行业级");
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => { setResult(null); setError(null); }, [step.n]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.runRegression(regStep, granularity));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="warnbox">
        ⚠ 冲击变量为<b>拟真演示面板</b>(以 2018–2020 全球贸易摩擦为原型,覆盖全部经济体、行业异质),仅用于验证系统链路;接入 PIIE/WTO 真实数据后才具研究意义。
      </div>
      <div className="controls">
        <label>粒度</label>
        <select value={granularity} onChange={(e) => setGranularity(e.target.value)}>
          <option value="国家–行业级">国家–行业级(默认)</option>
          <option value="国家级">国家级</option>
        </select>
      </div>
      {result && <div className="eq-box">{result.design.equation}</div>}
      <button className="run-btn" onClick={run} disabled={running}>
        {running ? "估计中…" : "▶ 运行回归"}
      </button>
      {error && <div className="error-box" style={{ marginTop: 14 }}>{error}</div>}
      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>变量</th><th>系数</th><th>聚类标准误</th><th>t</th><th>p</th><th>显著</th></tr></thead>
              <tbody>
                {result.result.coefs.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.coef.toFixed(4)}</td>
                    <td>{c.se.toFixed(4)}</td>
                    <td>{c.t.toFixed(2)}</td>
                    <td>{c.p.toFixed(3)}</td>
                    <td>{c.stars}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            被解释变量:{result.design.depvar_label}({result.design.depvar})· {result.design.granularity} · N = {result.result.n_obs}
            ({result.result.n_entities} 个体 × {result.result.n_times} 年,{result.result.n_clusters} 国聚类)· 组内 R² = {result.result.r2_within.toFixed(4)}
          </p>
          {result.result.notes.map((n) => <p key={n} className="muted">· {n}</p>)}
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
