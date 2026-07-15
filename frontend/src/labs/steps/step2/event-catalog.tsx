import type { ShockEvent } from "../../../types";
import { sectorLabel } from "../../../viz";
import { pct } from "../../shared";
import { eventKey } from "./model";

export function EventCatalog({
  events,
  selectedKey,
  onSelect,
}: {
  events: ShockEvent[];
  selectedKey: string | null;
  onSelect: (event: ShockEvent) => void;
}) {
  return (
    <details className="shock-details event-catalog">
      <summary>
        <span>查看全部政策事件清单</span>
        <span className="shock-details-meta">{events.length} 个事件 · 默认收起</span>
      </summary>
      <div className="table-wrap">
        <table className="data-table shock-event-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>事件</th><th>类型</th><th>发起方 → 目标</th>
              <th>宣布</th><th>生效</th><th>涉及行业</th><th>峰值强度</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const key = eventKey(event);
              const selected = key === selectedKey;
              return (
                <tr key={key} className={selected ? "selected" : ""}>
                  <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                    <button
                      type="button"
                      className="shock-event-link"
                      aria-pressed={selected}
                      onClick={() => onSelect(event)}
                    >
                      {event.name}
                    </button>
                    {event.entities && <div className="muted shock-event-entities">实体：{event.entities}</div>}
                  </td>
                  <td>{event.shock_type ?? "关税冲击"}</td>
                  <td>{event.imposer} → {event.targets}{event.exempt ? `（豁免：${event.exempt}）` : ""}</td>
                  <td>{event.announced}</td>
                  <td>{event.effective}</td>
                  <td>{event.n_sectors} 个<br /><span className="muted">{event.top_sectors.map(sectorLabel).join("、")}</span></td>
                  <td>{pct(event.peak_rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
