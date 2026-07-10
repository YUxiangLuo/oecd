import { useMemo, useState } from "react";
import { api } from "../../api";
import type { CrosswalkHsRow, CrosswalkPayload, Meta, PagedRows, ShockEvent, ShockSummary } from "../../types";
import { sectorLabel } from "../../viz";
import { Pager, pct, useAsync } from "../shared";

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
                    <td title={r.icio_sector}>{sectorLabel(r.icio_sector)}</td>
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

const EVENT_COLORS: Record<string, string> = {
  关税冲击: "#2a78d6",
  制裁清单: "#e34948",
  出口管制: "#eda100",
};

const dateNumber = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

function EventTimeline({ events, onSelect }: { events: ShockEvent[]; onSelect: (event: ShockEvent) => void }) {
  const model = useMemo(() => {
    const dated = events.flatMap((event) => [dateNumber(event.announced), dateNumber(event.effective)])
      .filter((value): value is number => value != null);
    const fallbackStart = Date.UTC(2016, 0, 1);
    const fallbackEnd = Date.UTC(2020, 11, 31);
    const start = dated.length ? Math.min(...dated, fallbackStart) : fallbackStart;
    const end = dated.length ? Math.max(...dated, fallbackEnd) : fallbackEnd;
    return { start, end: Math.max(end, start + 1) };
  }, [events]);
  const W = 960;
  const left = 230;
  const right = 36;
  const top = 38;
  const rowHeight = 40;
  const height = top + Math.max(1, events.length) * rowHeight + 36;
  const x = (value: string) => {
    const timestamp = dateNumber(value) ?? model.start;
    return left + ((timestamp - model.start) / (model.end - model.start)) * (W - left - right);
  };
  const firstYear = new Date(model.start).getUTCFullYear();
  const lastYear = new Date(model.end).getUTCFullYear();
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  const yearX = (year: number) => x(`${year}-01-01`);
  return (
    <div style={{ border: "1px solid #e8eaf0", borderRadius: 12, overflowX: "auto", background: "#fff", marginBottom: 14 }}>
      <svg viewBox={`0 0 ${W} ${height}`} style={{ display: "block", minWidth: 820, width: "100%" }} aria-label="政策事件宣布与生效时间线">
        {years.map((year) => (
          <g key={year}>
            <line x1={yearX(year)} y1={top - 10} x2={yearX(year)} y2={height - 24} stroke="#eef0f5" />
            <text x={yearX(year)} y={18} textAnchor="middle" fontSize="11" fill="#8a90a0">{year}</text>
          </g>
        ))}
        {events.map((event, index) => {
          const y = top + index * rowHeight + rowHeight / 2;
          const xa = x(event.announced);
          const xe = x(event.effective);
          const color = EVENT_COLORS[event.shock_type ?? "关税冲击"] ?? "#4a3aa7";
          return (
            <g key={`${event.name}-${event.effective}`} role="button" tabIndex={0} style={{ cursor: "pointer" }}
              onClick={() => onSelect(event)}
              onKeyDown={(keyEvent) => (keyEvent.key === "Enter" || keyEvent.key === " ") && onSelect(event)}>
              <title>点击筛选：{event.name}；宣布 {event.announced}，生效 {event.effective}</title>
              <rect x={2} y={y - 17} width={W - 4} height={34} rx={6} fill="transparent" />
              <text x={12} y={y + 4} fontSize="11.5" fill="#3a4050">{event.name.length > 28 ? `${event.name.slice(0, 27)}…` : event.name}</text>
              <line x1={xa} y1={y} x2={xe} y2={y} stroke={color} strokeWidth={3} strokeLinecap="round" />
              <circle cx={xa} cy={y} r={6} fill="#fff" stroke={color} strokeWidth={2.5} />
              <circle cx={xe} cy={y} r={6} fill={color} stroke="#fff" strokeWidth={1.5} />
              <text x={xa} y={y - 10} textAnchor="middle" fontSize="9.5" fill="#777e8e">宣布</text>
              <text x={xe} y={y + 15} textAnchor="middle" fontSize="9.5" fill={color}>生效</text>
            </g>
          );
        })}
      </svg>
      <div style={{ padding: "0 12px 10px", display: "flex", gap: 16, fontSize: 11, color: "#737a8a", flexWrap: "wrap" }}>
        <span>○ 宣布</span><span>● 生效</span>
        {Object.entries(EVENT_COLORS).map(([label, color]) => <span key={label} style={{ color }}>● {label}</span>)}
        <span>点击事件可联动下方年份、类型、目标国与首个行业</span>
      </div>
    </div>
  );
}

/** 步骤2:政策冲击数据 —— 事件时间线 + 覆盖概览 + 面板浏览 */
export function ShockLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1) ?? 2020);
  const [shockType, setShockType] = useState("关税冲击");
  const [country, setCountry] = useState("");
  const [sector, setSector] = useState("");
  const [onlyHit, setOnlyHit] = useState(true);
  const [page, setPage] = useState(1);

  const { data: events, error: evErr } = useAsync(() => api.shockEvents(), []);
  const { data: summary } = useAsync<ShockSummary>(() => api.shockSummary(shockType), [shockType]);
  const { data: panel, error: panelErr } = useAsync<PagedRows>(
    () => api.shockPanel(year, shockType, country, sector, onlyHit, page),
    [year, shockType, country, sector, onlyHit, page],
  );

  const summaryYear = summary?.years.find((r) => r.year === year);
  const pages = panel ? Math.max(1, Math.ceil(panel.total / panel.page_size)) : 1;
  const pickEvent = (event: ShockEvent) => {
    if (event.shock_type) setShockType(event.shock_type);
    const effectiveYear = Number.parseInt(event.effective.slice(0, 4), 10);
    if (Number.isFinite(effectiveYear) && meta.years.length) {
      const closest = [...meta.years].sort((a, b) => Math.abs(a - effectiveYear) - Math.abs(b - effectiveYear))[0];
      setYear(closest);
    }
    const uniqueTarget = !event.all_targets && event.target_codes?.length === 1 ? event.target_codes[0] : "";
    setCountry(uniqueTarget && meta.countries.includes(uniqueTarget) ? uniqueTarget : "");
    const firstSector = event.sector_codes?.find((code) => meta.sectors.includes(code)) ?? "";
    setSector(firstSector);
    setOnlyHit(true);
    setPage(1);
  };

  return (
    <div>
      <div className="warnbox">
        ⚠ 拟真演示数据:以 2018–2020 全球贸易摩擦真实事件为原型手工编码(税率量级参考
        PIIE/Bown),出口暴露度由 OECD ICIO 双边流向计算;覆盖 {summary ? `${summary.n_countries} 个经济体 × ${summary.n_sectors} 个行业` : "全部经济体与行业"},不能用于研究结论。
      </div>

      <h3 style={{ margin: "18px 0 10px", fontSize: 15 }}>事件时间线</h3>
      {evErr && <div className="error-box">{evErr}</div>}
      <EventTimeline events={events?.events ?? []} onSelect={pickEvent} />
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
                <td>{e.n_sectors} 个(主要:{e.top_sectors.map(sectorLabel).join("、")})</td>
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
        <select value={sector} onChange={(e) => { setSector(e.target.value); setPage(1); }}>
          <option value="">全部</option>
          {meta.sectors.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
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
            <tr><th style={{ textAlign: "left" }}>国家</th><th>行业</th><th>冲击强度</th><th>主要加征方</th><th>ICIO 出口暴露度</th><th>受处理</th><th>宣布</th><th>生效</th><th style={{ textAlign: "left" }}>主要事件</th></tr>
          </thead>
          <tbody>
            {(panel?.rows ?? []).map((r, i) => (
              <tr key={i}>
                <td style={{ textAlign: "left" }}>{String(r.country)}</td>
                <td>{sectorLabel(String(r.sector))}</td>
                <td>{typeof r.tariff_shock === "number" ? pct(r.tariff_shock) : "—"}</td>
                <td>{String(r.main_imposer ?? r.primary_imposer ?? r.imposer ?? "—")}</td>
                <td title="该经济体全部出口中流向主要加征方的份额（来自真实 OECD ICIO 双边流向）">
                  {typeof r.export_exposure === "number" ? pct(r.export_exposure) : "—"}
                </td>
                <td>{r.treated === 1 ? "✓" : ""}</td>
                <td>{r.announced_date ?? "—"}</td>
                <td>{r.effective_date ?? "—"}</td>
                <td style={{ textAlign: "left", whiteSpace: "normal" }}>{r.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tipbox" style={{ marginTop: 12 }}>
        关税冲击按“事件税率 × 对加征方出口暴露度”汇总；ICIO 暴露度使用真实双边投入产出流。总冲击可能同时包含多个事件，因此不一定等于表中主要加征方的单项乘积。
      </div>
      <div style={{ marginTop: 12 }}>
        <Pager page={page} pages={pages} total={panel?.total} onChange={setPage} />
      </div>
    </div>
  );
}
