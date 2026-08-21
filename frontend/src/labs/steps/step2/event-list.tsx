import { useMemo } from "react";
import type { ShockEvent } from "../../../types";
import { pct } from "../../shared";
import { SHOCK_TYPES, SHOCK_TYPE_COLORS, SHOCK_TYPE_LABELS, eventKey, shockTypeColor } from "./model";

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
  onSelect,
}: {
  events: ShockEvent[];
  selectedKey: string | null;
  onSelect: (event: ShockEvent) => void;
}) {
  const domain = useDomain(events);
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

  return (
    <div className="shock-event-list">
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

      {SHOCK_TYPES.map((type) => {
        const items = events.filter((event) => (event.shock_type ?? "tariff") === type);
        if (!items.length) return null;
        return (
          <div key={type} className="shock-event-group">
            <div className="shock-event-group-head" style={{ color: SHOCK_TYPE_COLORS[type] }}>
              <span>● {SHOCK_TYPE_LABELS[type]}</span>
              <span className="shock-event-group-count">{items.length} 个</span>
            </div>
            {items.map((event) => {
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
                  type="button"
                  className={`shock-event-item${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() => onSelect(event)}
                  style={on ? { borderColor: color } : undefined}
                >
                  <span className="shock-event-item-top">
                    <span className="shock-event-item-name">{event.name}</span>
                    {event.peak_rate > 0 && <span className="shock-event-item-rate">教学峰值 {pct(event.peak_rate)}</span>}
                  </span>
                  <span className="shock-event-item-meta">
                    {event.imposer} → {event.targets} · {event.n_sectors} 个行业
                  </span>
                  <span className={`shock-event-source ${event.source_status === "official_event_source" ? "official" : "teaching"}`}>
                    {event.source_status === "official_event_source"
                      ? "事件/日期：有官方来源"
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
        );
      })}
    </div>
  );
}
