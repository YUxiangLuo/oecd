import { useState } from "react";
import { api } from "../../api";
import type { CrosswalkHsRow, CrosswalkPayload, IndustryPage, Meta, ShockEvent, ShockSummary } from "../../types";
import { pct, useAsync } from "../shared";

const CROSSWALK_YEARS = [2018, 2019, 2020];

function crosswalkRate(row: CrosswalkHsRow, year: number) {
  if (year === 2018) return row.rate_2018;
  if (year === 2020) return row.rate_2020;
  return row.rate_2019;
}

/** 步骤2 子实验:HS 清单税率 → ICIO 行业平均冲击 */
function CrosswalkDemo() {
  const [year, setYear] = useState(2019);
  const { data, error } = useAsync<CrosswalkPayload>(() => api.crosswalkDemo(year), [year]);
  const mappedRows = data?.mapped_rows.slice(0, 10) ?? [];

  return (
    <div>
      <div className="section-head" style={{ marginTop: 22 }}>
        <span className="section-head-icon">↔</span>从 HS 清单到 ICIO 行业
        <span className="section-head-line" />
      </div>
      <div className="controls">
        <label>折算年份</label>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {CROSSWALK_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {data && (
          <span className="muted">
            HS {data.summary.n_hs_chapters} 章 → ICIO {data.summary.n_icio_sectors} 个商品相关行业
          </span>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      {!data ? (
        <p className="muted">正在读取 HS↔ICIO 映射演示…</p>
      ) : (
        <>
          <div className="tipbox">
            {data.disclaimer} 当前 301 清单样本覆盖 {pct(data.summary.demo_list_value_coverage)} 的示例贸易额,
            crosswalk 共 {data.summary.n_crosswalk_rows} 条一对多映射。
          </div>

          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table className="data-table">
              <thead>
                <tr><th>映射质检</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr>
              </thead>
              <tbody>
                {data.checks.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className={c.passed ? "qc-pass" : "qc-fail"}>{c.passed ? "通过" : "异常"}</td>
                    <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                      {c.detail}
                      {c.warnings.map((w) => <div key={w} className="muted">{w}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <table className="data-table">
              <thead>
                <tr><th>HS章</th><th>清单</th><th>贸易额权重</th><th>清单覆盖</th><th>{year} 税率</th><th style={{ textAlign: "left" }}>说明</th></tr>
              </thead>
              <tbody>
                {data.hs_rows.map((r) => (
                  <tr key={r.hs_chapter}>
                    <td>{r.hs_chapter}</td>
                    <td>{r.list_name}</td>
                    <td>{pct(r.value_weight)}</td>
                    <td>{pct(r.coverage)}</td>
                    <td>{pct(crosswalkRate(r, year))}</td>
                    <td style={{ textAlign: "left" }}>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>ICIO行业</th><th>行业平均税率</th><th>映射贸易权重</th><th>受影响权重</th><th style={{ textAlign: "left" }}>主要HS章</th></tr>
              </thead>
              <tbody>
                {mappedRows.map((r) => (
                  <tr key={r.icio_sector}>
                    <td>{r.icio_sector}</td>
                    <td>{pct(r.avg_tariff)}</td>
                    <td>{pct(r.mapped_value_weight)}</td>
                    <td>{pct(r.affected_value_weight)}</td>
                    <td style={{ textAlign: "left" }}>{r.top_hs_chapters}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** 步骤2:政策冲击数据 —— 事件时间线 + 覆盖概览 + 面板浏览 */
export function ShockLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1) ?? 2020);
  const [shockType, setShockType] = useState("关税冲击");
  const [country, setCountry] = useState("");
  const [industry, setIndustry] = useState("");
  const [onlyHit, setOnlyHit] = useState(true);
  const [page, setPage] = useState(1);

  const { data: events, error: evErr } = useAsync(() => api.shockEvents(), []);
  const { data: summary } = useAsync<ShockSummary>(() => api.shockSummary(shockType), [shockType]);
  const { data: panel, error: panelErr } = useAsync<IndustryPage>(
    () => api.shockPanel(year, shockType, country, industry, onlyHit, page),
    [year, shockType, country, industry, onlyHit, page],
  );

  const summaryYear = summary?.years.find((r) => r.year === year);
  const pages = panel ? Math.max(1, Math.ceil(panel.total / panel.page_size)) : 1;

  return (
    <div>
      <div className="warnbox">
        ⚠ 拟真演示数据:以 2018–2020 全球贸易摩擦真实事件为原型手工编码(税率量级参考
        PIIE/Bown),出口暴露度由 OECD ICIO 双边流向计算;覆盖 {summary ? `${summary.n_countries} 个经济体 × ${summary.n_industries} 个行业` : "全部经济体与行业"},不能用于研究结论。
      </div>

      <h3 style={{ margin: "18px 0 10px", fontSize: 15 }}>事件时间线</h3>
      {evErr && <div className="error-box">{evErr}</div>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th style={{ textAlign: "left" }}>事件</th><th>类型</th><th>发起方 → 目标</th><th>宣布</th><th>生效</th><th>涉及行业</th><th>峰值强度</th></tr>
          </thead>
          <tbody>
            {(events?.events ?? []).map((e: ShockEvent) => (
              <tr key={e.name}>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {e.name}
                  {e.entities && <div className="muted">实体:{e.entities}</div>}
                </td>
                <td>{e.shock_type ?? "关税冲击"}</td>
                <td>{e.imposer} → {e.targets}{e.exempt ? `(豁免:${e.exempt})` : ""}</td>
                <td>{e.announced}</td>
                <td>{e.effective}</td>
                <td>{e.n_industries} 个(主要:{e.top_industries.join("、")})</td>
                <td>{pct(e.peak_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CrosswalkDemo />

      <h3 style={{ margin: "22px 0 10px", fontSize: 15 }}>冲击面板浏览</h3>
      <div className="controls">
        <label>冲击类型</label>
        <select value={shockType} onChange={(e) => { setShockType(e.target.value); setPage(1); }}>
          {["关税冲击", "制裁清单", "出口管制"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
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
        <select value={industry} onChange={(e) => { setIndustry(e.target.value); setPage(1); }}>
          <option value="">全部</option>
          {meta.industries.map((s) => <option key={s} value={s}>{s}</option>)}
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
            <tr><th style={{ textAlign: "left" }}>国家</th><th>行业</th><th>冲击强度</th><th>受处理</th><th>宣布</th><th>生效</th><th style={{ textAlign: "left" }}>主要事件</th></tr>
          </thead>
          <tbody>
            {(panel?.rows ?? []).map((r, i) => (
              <tr key={i}>
                <td style={{ textAlign: "left" }}>{String(r.country)}</td>
                <td>{String(r.industry)}</td>
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
