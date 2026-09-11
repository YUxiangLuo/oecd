import { useMemo, useRef } from "react";
import type { ShockEvent } from "../../../types";
import { pct } from "../../shared";
import {
  SHOCK_TYPES,
  SHOCK_TYPE_COLORS,
  SHOCK_TYPE_LABELS,
  eventKey,
  normalizeShockType,
  shockTypeColor,
  type ShockType,
} from "./model";

/**
 * 左右联动工作台的左列:按三类冲击分组的事件选择器,点选即联动右侧面板。
 *
 * 每行内嵌一条「宣布 ○━━● 生效(○ 解除)」迷你时间条。刻意让所有行**共用同一条时间刻度**
 * (顶部年份轴),所以横向位置可以跨事件比较——谁先宣布、谁的宣布到生效拖得更久,
 * 一眼可见。这里的单个事件只用于探索定位；下游事件研究使用所选冲击类型汇总面板中
 * 各个体的首次处理年，而不是把当前单个事件直接当作回归筛选。
 * 分组帮助学生主动比较关税、制裁与出口管制三类冲击的覆盖差异。
 */
const dateNumber = (value: string | null | undefined) => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

/** 所有事件共用的时间域:取实际数据范围(而非固定 2016–2020),让时滞看得更清楚。 */
function useDomain(events: ShockEvent[]) {
  return useMemo(() => {
    const stamps = events
      .flatMap((event) => [dateNumber(event.announced), dateNumber(event.effective), dateNumber(event.removal)])
      .filter((value): value is number => value != null);
    if (!stamps.length) return null;
    const start = Math.min(...stamps);
    const end = Math.max(...stamps);
    return { start, end: end > start ? end : start + 1 };
  }, [events]);
}

export function EventList({
  events,
  selectedKey,
  activeType,
  viewedTypes,
  viewedEventCount,
  onTypeChange,
  onSelect,
}: {
  events: ShockEvent[];
  selectedKey: string | null;
  activeType: string;
  viewedTypes: string[];
  viewedEventCount: number;
  onTypeChange: (type: ShockType) => void;
  onSelect: (event: ShockEvent) => void;
}) {
  const domain = useDomain(events);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedType = normalizeShockType(activeType);
  const eventCountByType = Object.fromEntries(SHOCK_TYPES.map((type) => [
    type,
    events.filter((event) => normalizeShockType(event.shock_type) === type).length,
  ])) as Record<ShockType, number>;
  const selectableTypes = SHOCK_TYPES.filter((type) => eventCountByType[type] > 0);
  const viewedTypeSet = new Set(viewedTypes.filter((type): type is ShockType => (
    SHOCK_TYPES.includes(type as ShockType)
  )));
  const viewedSelectableCount = selectableTypes.filter((type) => viewedTypeSet.has(type)).length;
  const activeItems = events.filter((event) => normalizeShockType(event.shock_type) === selectedType);
  const selectedIndex = activeItems.findIndex((event) => eventKey(event) === selectedKey);
  const tabStopType = selectableTypes.includes(selectedType) ? selectedType : selectableTypes[0];
  // 百分比定位:配合 CSS 绝对定位,列宽变化时时间条自动跟随,不会像定宽 SVG 那样变形。
  const at = (value: string | null | undefined) => {
    const timestamp = dateNumber(value);
    if (domain == null || timestamp == null) return null;
    return ((timestamp - domain.start) / (domain.end - domain.start)) * 100;
  };
  const years = useMemo(() => {
    if (!domain) return [];
    const first = new Date(domain.start).getUTCFullYear();
    const last = new Date(domain.end).getUTCFullYear();
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }, [domain]);

  const moveType = (currentType: ShockType, key: string) => {
    const activeTabIndex = selectableTypes.indexOf(currentType);
    const nextIndex = key === "Home" ? 0
      : key === "End" ? selectableTypes.length - 1
        : key === "ArrowRight" ? (activeTabIndex + 1) % selectableTypes.length
          : key === "ArrowLeft" ? (activeTabIndex - 1 + selectableTypes.length) % selectableTypes.length
            : -1;
    if (nextIndex < 0 || !selectableTypes[nextIndex]) return false;
    const nextType = selectableTypes[nextIndex];
    onTypeChange(nextType);
    requestAnimationFrame(() => document.getElementById(`shock-type-tab-${nextType}`)?.focus());
    return true;
  };

  const moveEvent = (index: number, key: string) => {
    const nextIndex = key === "Home" ? 0
      : key === "End" ? activeItems.length - 1
        : key === "ArrowDown" ? (index + 1) % activeItems.length
          : key === "ArrowUp" ? (index - 1 + activeItems.length) % activeItems.length
            : -1;
    if (nextIndex < 0 || !activeItems[nextIndex]) return false;
    onSelect(activeItems[nextIndex]);
    requestAnimationFrame(() => itemRefs.current[nextIndex]?.focus());
    return true;
  };

  return (
    <div className="shock-event-browser">
      <div className="shock-event-progress" role="status">
        <span><b>比较进度</b> 已查看 {viewedSelectableCount}/{selectableTypes.length} 个可选类型</span>
        <span>{viewedEventCount} 个事件</span>
      </div>
      <div className="seg shock-type-tabs" role="tablist" aria-label="政策冲击类型">
        {SHOCK_TYPES.map((type) => {
          const count = eventCountByType[type];
          const selectable = count > 0;
          const selected = type === selectedType;
          return (
            <button
              key={type}
              id={`shock-type-tab-${type}`}
              type="button"
              role="tab"
              className={selected ? "on" : ""}
              tabIndex={selectable && type === tabStopType ? 0 : -1}
              aria-selected={selected}
              aria-controls="shock-event-type-panel"
              disabled={!selectable}
              onClick={() => onTypeChange(type)}
              onKeyDown={(event) => {
                if (moveType(type, event.key)) event.preventDefault();
              }}
            >
              {viewedTypeSet.has(type) && selectable ? "✓ " : ""}{SHOCK_TYPE_LABELS[type]} {count}
            </button>
          );
        })}
      </div>
      <div
        id="shock-event-type-panel"
        className="shock-event-list"
        role="tabpanel"
        aria-labelledby={`shock-type-tab-${selectedType}`}
      >
      {/* 刻度轨道必须与行内时间条**同一横向范围**,否则年份读不准。因此这里不放任何
          并排标签(○/● 的含义由左列说明文字给出),并用与事件卡片相同的左右内缩对齐。 */}
      {domain && (
        <div className="shock-event-axis" aria-hidden="true">
          <span className="shock-event-axis-track">
            {years.map((year) => {
              const left = at(`${year}-01-01`);
              return left == null || left < 0 || left > 100 ? null : (
                <span key={year} className="shock-event-axis-tick" style={{ left: `${left}%` }}>{year}</span>
              );
            })}
          </span>
        </div>
      )}

      <div className="shock-event-group">
        <div className="shock-event-group-head" style={{ color: SHOCK_TYPE_COLORS[selectedType] }}>
          <span>● {SHOCK_TYPE_LABELS[selectedType]}</span>
          <span className="shock-event-group-count">{activeItems.length} 个</span>
        </div>
        {activeItems.length === 0 ? (
          <div className="shock-event-empty">当前 release 没有可选择的{SHOCK_TYPE_LABELS[selectedType]}事件；该类型不计入报告材料门槛。</div>
        ) : activeItems.map((event, index) => {
              const key = eventKey(event);
              const on = key === selectedKey;
              const color = shockTypeColor(event.shock_type);
              const a = at(event.announced);
              const e = at(event.effective);
              const r = at(event.removal);
              const span = a != null && e != null ? { left: Math.min(a, e), width: Math.abs(e - a) } : null;
              const dates = `宣布 ${event.announced} · 生效 ${event.effective}${event.removal ? ` · 解除 ${event.removal}` : ""}`;
              return (
                <button
                  key={key}
                  ref={(node) => { itemRefs.current[index] = node; }}
                  type="button"
                  className={`shock-event-item${on ? " on" : ""}`}
                  aria-pressed={on}
                  tabIndex={selectedIndex >= 0 ? (on ? 0 : -1) : (index === 0 ? 0 : -1)}
                  onClick={() => onSelect(event)}
                  onKeyDown={(keyboardEvent) => {
                    if (moveEvent(index, keyboardEvent.key)) keyboardEvent.preventDefault();
                  }}
                  style={on ? { borderColor: color } : undefined}
                >
                  <span className="shock-event-item-top">
                    <span className="shock-event-item-name">{event.name}</span>
                    {event.peak_rate > 0 && <span className="shock-event-item-rate">教学峰值 {pct(event.peak_rate)}</span>}
                  </span>
                  <span className="shock-event-item-meta">
                    {event.imposer} → {event.targets} · {event.n_sectors} 个行业
                  </span>
                  <span className={`shock-event-source ${event.source_status === "teaching_encoding_no_event_source" ? "teaching" : event.source_status === "partial_official_event_source" ? "partial" : "official"}`}>
                    {event.source_status === "official_event_source_complete"
                      ? "事件/日期：官方来源覆盖完整"
                      : event.source_status === "partial_official_event_source"
                        ? "事件/日期：官方来源仅部分覆盖"
                        : "事件/日期：未逐项引证的教学编码"}
                  </span>
                  {span && (
                    <span className="shock-event-spark" title={dates}>
                      <span className="shock-event-spark-track" />
                      <span
                        className="shock-event-spark-bar"
                        style={{ left: `${span.left}%`, width: `${span.width}%`, background: color }}
                      />
                      {a != null && (
                        <span className="shock-event-spark-dot" style={{ left: `${a}%`, borderColor: color }} />
                      )}
                      {e != null && (
                        <span
                          className="shock-event-spark-dot on"
                          style={{ left: `${e}%`, background: color, borderColor: color }}
                        />
                      )}
                      {r != null && (
                        <span className="shock-event-spark-dot" style={{ left: `${r}%`, borderColor: color }} />
                      )}
                    </span>
                  )}
                  <span className="shock-event-item-dates">
                    {event.announced.slice(0, 7)} → {event.effective.slice(0, 7)}
                    {event.removal ? ` → ${event.removal.slice(0, 7)} 解除` : ""}
                  </span>
                </button>
              );
        })}
      </div>
      </div>
    </div>
  );
}
