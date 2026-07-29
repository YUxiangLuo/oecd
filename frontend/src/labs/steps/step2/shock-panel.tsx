import { useRef } from "react";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { Meta, PagedRows, ShockSummary } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { SHOCK_TYPES, SHOCK_TYPE_LABELS, type ShockType } from "./model";
import { Pager, pct, useAsync } from "../../shared";
import type { ShockPanelFilters } from "./model";

/**
 * 保留上一次的结果,直到新数据到达。
 *
 * useAsync 在依赖变化时会先把 data 置空(shared.tsx),面板每次联动都会经历
 * 「整张表 → 一行"正在读取" → 新表」,配合 1~25 行的行数差,整页会先塌缩再撑开。
 * 这里改成 stale-while-revalidate:旧表留在原位淡化,新表到达再替换。
 */
function useLastNonNull<T>(value: T | null): T | null {
  const ref = useRef<T | null>(null);
  if (value != null) ref.current = value;
  return value ?? ref.current;
}

export function ShockPanel({
  meta,
  filters,
  onChange,
}: {
  meta: Meta;
  filters: ShockPanelFilters;
  onChange: (patch: Partial<ShockPanelFilters>) => void;
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
  // 出错时不沿用旧数据(会把失败伪装成成功);只有"正在重取"才保留上一份。
  const shownSummary = useLastNonNull(summaryError ? null : summary);
  const shownPanel = useLastNonNull(panelError ? null : panel);
  const refreshing = (panel == null && panelError == null) || (summary == null && summaryError == null);
  const summaryYear = shownSummary?.years.find((row) => row.year === filters.year);
  const pages = shownPanel ? Math.max(1, Math.ceil(shownPanel.total / shownPanel.page_size)) : 1;

  return (
    <div className="shock-panel-embedded" role="region" aria-label="国家–行业冲击面板">
      <div className="controls shock-panel-controls">
        <span className="field">
          <LabeledControl label="冲击类型">
            {(id) => (
              <select id={id} value={filters.shockType} onChange={(event) => onChange({ shockType: event.target.value, page: 1 })}>
                {SHOCK_TYPES.map((value) => <option key={value} value={value}>{SHOCK_TYPE_LABELS[value]}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="年份">
            {(id) => (
              <select id={id} value={filters.year} onChange={(event) => onChange({ year: Number(event.target.value), page: 1 })}>
                {meta.years.map((value) => <option key={value}>{value}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="国家">
            {(id) => (
              <select id={id} value={filters.country} onChange={(event) => onChange({ country: event.target.value, page: 1 })}>
                <option value="">全部</option>
                {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
              </select>
            )}
          </LabeledControl>
        </span>
        <span className="field">
          <LabeledControl label="行业">
            {(id) => (
              <select id={id} value={filters.sector} onChange={(event) => onChange({ sector: event.target.value, page: 1 })}>
                <option value="">全部</option>
                {meta.sectors.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
              </select>
            )}
          </LabeledControl>
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

      {/* 概览行常驻:切换事件会同时改年份与冲击类型,按年份查不到时若整行消失,又是一次高度跳变。 */}
      {summaryError ? <div className="error-box">冲击概览读取失败：{summaryError}</div> : (
        <div className="shock-panel-summary">
          <strong>{filters.year} 年 · {SHOCK_TYPE_LABELS[filters.shockType as ShockType] ?? filters.shockType}</strong>
          {summaryYear ? (
            <>
              <span>{summaryYear.treated_countries} 个经济体</span>
              <span>{summaryYear.treated_pairs} 个国家–行业受冲击</span>
              {summaryYear.max_shock > 0 && <span>最高 {pct(summaryYear.max_shock)}（{summaryYear.max_shock_target}）</span>}
            </>
          ) : <span className="muted">正在读取该口径的冲击概览…</span>}
        </div>
      )}

      {/* 定高区:行数在 1~25 之间跳变(每页 25 条),不锁高度整页会随联动上下弹。 */}
      <div className={`shock-panel-body${refreshing ? " refreshing" : ""}`}>
      {panelError ? <div className="error-box">冲击面板读取失败：{panelError}</div> : !shownPanel ? (
        <div className="shock-panel-state">正在按当前条件读取冲击面板…</div>
      ) : shownPanel.rows.length === 0 ? (
        <div className="shock-panel-state">当前条件下没有记录；可以放宽国家、行业或“只看受冲击”筛选。</div>
      ) : (
        <ScrollableRegion className="table-wrap" label="国家行业冲击面板表，可横向滚动">
          <table className="data-table shock-panel-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>国家</th><th>行业</th><th>冲击强度</th><th>主要加征方</th>
                <th>ICIO 出口暴露度</th><th>受处理</th><th>宣布</th><th>生效</th><th style={{ textAlign: "left" }}>主要事件</th>
              </tr>
            </thead>
            <tbody>
              {shownPanel.rows.map((row, index) => (
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
        </ScrollableRegion>
      )}
      {/* 事件联动常把口径收窄到单个国家×行业,定高后会空出一片。与其留白,
          不如把它变成"怎么看到完整范围"的引导——顺带点明左右两侧是同一套筛选。 */}
      {shownPanel && shownPanel.rows.length > 0 && shownPanel.total <= shownPanel.page_size && (
        <p className="shock-panel-hint">
          以上是当前口径下的全部 {shownPanel.total} 条命中。想看这次冲击波及的完整范围,
          可把上方的「国家 / 行业」改回“全部”。
        </p>
      )}
      </div>

      <div className="tipbox shock-panel-note">
        关税冲击按“事件税率 × 对加征方出口暴露度”汇总；ICIO 暴露度使用真实双边投入产出流。总冲击可能包含多个事件，因此不一定等于主要加征方的单项乘积。
      </div>
      {shownPanel && shownPanel.rows.length > 0 && (
        <Pager page={filters.page} pages={pages} total={shownPanel.total} onChange={(page) => onChange({ page })} />
      )}
    </div>
  );
}
