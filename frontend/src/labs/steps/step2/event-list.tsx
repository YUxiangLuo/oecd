import type { ShockEvent } from "../../../types";
import { pct } from "../../shared";
import { SHOCK_TYPES, SHOCK_TYPE_COLORS, SHOCK_TYPE_LABELS, eventKey } from "./model";

/** 左右联动工作台的左列:按三类冲击分组的紧凑事件列表,点选即联动右侧面板。
 *  分组本身也在提醒学生"关税 / 制裁 / 出口管制三类都要各看一个"(本步证据要求)。 */
export function EventList({
  events,
  selectedKey,
  onSelect,
}: {
  events: ShockEvent[];
  selectedKey: string | null;
  onSelect: (event: ShockEvent) => void;
}) {
  return (
    <div className="shock-event-list">
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
              return (
                <button
                  key={key}
                  type="button"
                  className={`shock-event-item${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() => onSelect(event)}
                  style={on ? { borderColor: SHOCK_TYPE_COLORS[type] } : undefined}
                >
                  <span className="shock-event-item-name">{event.name}</span>
                  <span className="shock-event-item-meta">
                    {event.imposer} → {event.targets} · 生效 {event.effective}
                    {event.peak_rate > 0 && ` · 峰值 ${pct(event.peak_rate)}`}
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
