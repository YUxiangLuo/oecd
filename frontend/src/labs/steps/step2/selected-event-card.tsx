import type { ShockEvent } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import type { ShockPanelFilters } from "./model";

export function SelectedEventCard({
  event,
  filters,
  filtersDirty,
  onViewPanel,
}: {
  event: ShockEvent | null;
  filters: ShockPanelFilters;
  filtersDirty: boolean;
  onViewPanel: () => void;
}) {
  if (!event) {
    return (
      <div className="selected-event-card empty" role="status" aria-live="polite">
        <div>
          <strong>尚未选择事件</strong>
          <p>从时间线选择一项政策事件；这里会立即显示它映射到冲击面板的年份、类型、目标经济体与代表行业。</p>
        </div>
        <span className="selected-event-filter-preview">
          当前面板：{filters.year} · {filters.shockType} · 全部经济体 · 全部行业
        </span>
      </div>
    );
  }

  const country = filters.country ? countryLabel(filters.country) : "全部经济体";
  const sector = filters.sector ? sectorLabel(filters.sector) : "全部行业";
  return (
    <div className="selected-event-card">
      <div className="selected-event-main">
        <span className="selected-event-kicker">✓ 已选择政策事件</span>
        <strong>{event.name}</strong>
        <div className="selected-event-meta">
          <span>{event.shock_type ?? "关税冲击"}</span>
          <span>宣布 {event.announced}</span>
          <span>生效 {event.effective}</span>
          <span>{event.imposer} → {event.targets}</span>
        </div>
      </div>
      <div className="selected-event-sync">
        <div className="selected-event-announcement" role="status" aria-live="polite">
          <span>{filtersDirty ? "面板筛选已在事件基础上调整" : "已同步冲击面板"}</span>
          <strong>{filters.year} · {filters.shockType} · {country} · {sector}</strong>
        </div>
        <button type="button" onClick={onViewPanel}>查看冲击面板 ↓</button>
      </div>
    </div>
  );
}
