import type { RefObject } from "react";
import { api } from "../../../api";
import type { Meta, PagedRows, ShockSummary } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { Pager, pct, useAsync } from "../../shared";
import type { ShockPanelFilters } from "./model";

export function ShockPanel({
  meta,
  filters,
  onChange,
  sectionRef,
}: {
  meta: Meta;
  filters: ShockPanelFilters;
  onChange: (patch: Partial<ShockPanelFilters>) => void;
  sectionRef: RefObject<HTMLElement | null>;
}) {
  const { data: summary, error: summaryError } = useAsync<ShockSummary>(
    () => api.shockSummary(filters.shockType),
    [filters.shockType],
  );
  const { data: panel, error: panelError } = useAsync<PagedRows>(
    () => api.shockPanel(
      filters.year,
      filters.shockType,
      filters.country,
      filters.sector,
      filters.onlyHit,
      filters.page,
    ),
    [filters.year, filters.shockType, filters.country, filters.sector, filters.onlyHit, filters.page],
  );
  const summaryYear = summary?.years.find((row) => row.year === filters.year);
  const pages = panel ? Math.max(1, Math.ceil(panel.total / panel.page_size)) : 1;

  return (
    <section ref={sectionRef} className="shock-workbench-section" aria-labelledby="shock-panel-title">
      <div className="shock-section-title" id="shock-panel-title" role="heading" aria-level={3}>
        <span>2</span>
        <div><strong>查看国家–行业冲击面板</strong><small>事件选择结果会直接同步到这里，也可以继续手动调整。</small></div>
      </div>
      <div className="controls shock-panel-controls">
        <span className="field">
          <label>冲击类型</label>
          <select value={filters.shockType} onChange={(event) => onChange({ shockType: event.target.value, page: 1 })}>
            {["关税冲击", "制裁清单", "出口管制"].map((value) => <option key={value}>{value}</option>)}
          </select>
        </span>
        <span className="field">
          <label>年份</label>
          <select value={filters.year} onChange={(event) => onChange({ year: Number(event.target.value), page: 1 })}>
            {meta.years.map((value) => <option key={value}>{value}</option>)}
          </select>
        </span>
        <span className="field">
          <label>国家</label>
          <select value={filters.country} onChange={(event) => onChange({ country: event.target.value, page: 1 })}>
            <option value="">全部</option>
            {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        </span>
        <span className="field">
          <label>行业</label>
          <select value={filters.sector} onChange={(event) => onChange({ sector: event.target.value, page: 1 })}>
            <option value="">全部</option>
            {meta.sectors.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
          </select>
        </span>
        <label className="shock-only-hit">
          <input
            type="checkbox"
            checked={filters.onlyHit}
            onChange={(event) => onChange({ onlyHit: event.target.checked, page: 1 })}
          />
          只看受冲击
        </label>
      </div>

      {summaryError && <div className="error-box">冲击概览读取失败：{summaryError}</div>}
      {summaryYear && (
        <div className="shock-panel-summary">
          <strong>{filters.year} 年 · {filters.shockType}</strong>
          <span>{summaryYear.treated_countries} 个经济体</span>
          <span>{summaryYear.treated_pairs} 个国家–行业受冲击</span>
          {summaryYear.max_shock > 0 && <span>最高 {pct(summaryYear.max_shock)}（{summaryYear.max_shock_target}）</span>}
        </div>
      )}

      {panelError ? <div className="error-box">冲击面板读取失败：{panelError}</div> : !panel ? (
        <div className="shock-panel-state">正在按当前条件读取冲击面板…</div>
      ) : panel.rows.length === 0 ? (
        <div className="shock-panel-state">当前条件下没有记录；可以放宽国家、行业或“只看受冲击”筛选。</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table shock-panel-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>国家</th><th>行业</th><th>冲击强度</th><th>主要加征方</th>
                <th>ICIO 出口暴露度</th><th>受处理</th><th>宣布</th><th>生效</th><th style={{ textAlign: "left" }}>主要事件</th>
              </tr>
            </thead>
            <tbody>
              {panel.rows.map((row, index) => (
                <tr key={`${row.country}-${row.sector}-${index}`}>
                  <td style={{ textAlign: "left" }}>{countryLabel(String(row.country))}</td>
                  <td>{sectorLabel(String(row.sector))}</td>
                  <td>{typeof row.tariff_shock === "number" ? pct(row.tariff_shock) : "—"}</td>
                  <td>{String(row.main_imposer ?? row.primary_imposer ?? row.imposer ?? "—")}</td>
                  <td title="该经济体全部出口中流向主要加征方的份额（来自真实 OECD ICIO 双边流向）">
                    {typeof row.export_exposure === "number" ? pct(row.export_exposure) : "—"}
                  </td>
                  <td>{row.treated === 1 ? "✓" : ""}</td>
                  <td>{row.announced_date ?? "—"}</td>
                  <td>{row.effective_date ?? "—"}</td>
                  <td style={{ textAlign: "left", whiteSpace: "normal" }}>{row.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="tipbox shock-panel-note">
        关税冲击按“事件税率 × 对加征方出口暴露度”汇总；ICIO 暴露度使用真实双边投入产出流。总冲击可能包含多个事件，因此不一定等于主要加征方的单项乘积。
      </div>
      {panel && panel.rows.length > 0 && (
        <Pager page={filters.page} pages={pages} total={panel.total} onChange={(page) => onChange({ page })} />
      )}
    </section>
  );
}
