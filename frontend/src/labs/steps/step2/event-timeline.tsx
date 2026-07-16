import { useMemo } from "react";
import type { ShockEvent } from "../../../types";
import { eventKey, SHOCK_TYPES, SHOCK_TYPE_COLORS, SHOCK_TYPE_LABELS, shockTypeColor, shockTypeLabel } from "./model";

const dateNumber = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function EventTimeline({
  events,
  selectedKey,
  onSelect,
}: {
  events: ShockEvent[];
  selectedKey: string | null;
  onSelect: (event: ShockEvent) => void;
}) {
  const model = useMemo(() => {
    const dated = events.flatMap((event) => [
      dateNumber(event.announced),
      dateNumber(event.effective),
      event.removal ? dateNumber(event.removal) : null,
    ])
      .filter((value): value is number => value != null);
    const fallbackStart = Date.UTC(2016, 0, 1);
    const fallbackEnd = Date.UTC(2020, 11, 31);
    const start = dated.length ? Math.min(...dated, fallbackStart) : fallbackStart;
    const end = dated.length ? Math.max(...dated, fallbackEnd) : fallbackEnd;
    return { start, end: Math.max(end, start + 1) };
  }, [events]);

  const width = 960;
  const left = 230;
  const right = 36;
  const top = 38;
  const rowHeight = 36;
  const height = top + Math.max(1, events.length) * rowHeight + 34;
  const x = (value: string) => {
    const timestamp = dateNumber(value) ?? model.start;
    return left + ((timestamp - model.start) / (model.end - model.start)) * (width - left - right);
  };
  const firstYear = new Date(model.start).getUTCFullYear();
  const lastYear = new Date(model.end).getUTCFullYear();
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);

  return (
    <div className="shock-timeline-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="shock-timeline"
        aria-label="政策事件宣布与生效时间线"
      >
        {years.map((year) => {
          const yearX = x(`${year}-01-01`);
          return (
            <g key={year}>
              <line x1={yearX} y1={top - 10} x2={yearX} y2={height - 24} stroke="#eef0f5" />
              <text x={yearX} y={18} textAnchor="middle" fontSize="11" fill="#8a90a0">{year}</text>
            </g>
          );
        })}
        {events.map((event, index) => {
          const key = eventKey(event);
          const selected = key === selectedKey;
          const y = top + index * rowHeight + rowHeight / 2;
          const announcedX = x(event.announced);
          const effectiveX = x(event.effective);
          const removalX = event.removal ? x(event.removal) : null;
          const color = shockTypeColor(event.shock_type);
          const labeled = Math.abs(effectiveX - announcedX) >= 48;
          const accessibleName = `${event.name}；${shockTypeLabel(event.shock_type)}；宣布 ${event.announced}；生效 ${event.effective}${event.removal ? `；解除 ${event.removal}` : ""}`;
          return (
            <g
              key={key}
              className="shock-timeline-event"
              role="button"
              tabIndex={0}
              aria-label={accessibleName}
              aria-pressed={selected}
              onClick={() => onSelect(event)}
              onKeyDown={(keyboardEvent) => {
                if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                  keyboardEvent.preventDefault();
                  onSelect(event);
                }
              }}
            >
              <rect className="shock-timeline-hit" x={2} y={y - 15} width={width - 4} height={30} rx={6} />
              <text x={12} y={y + 4} fontSize="11.5" fill="#3a4050">
                {event.name.length > 28 ? `${event.name.slice(0, 27)}…` : event.name}
              </text>
              <line x1={announcedX} y1={y} x2={effectiveX} y2={y} stroke={color} strokeWidth={3} strokeLinecap="round" />
              <circle cx={announcedX} cy={y} r={6} fill="#fff" stroke={color} strokeWidth={2.5} />
              <circle cx={effectiveX} cy={y} r={6} fill={color} stroke="#fff" strokeWidth={1.5} />
              {removalX != null && <circle cx={removalX} cy={y} r={6} fill="#fff" stroke={color} strokeWidth={2.5} />}
              {labeled && <text x={announcedX} y={y - 9} textAnchor="middle" fontSize="9.5" fill="#777e8e">宣布</text>}
              {labeled && <text x={effectiveX} y={y + 14} textAnchor="middle" fontSize="9.5" fill={color}>生效</text>}
              {removalX != null && <text x={removalX} y={y - 9} textAnchor="middle" fontSize="9.5" fill={color}>解除</text>}
              {selected && <text x={width - 16} y={y + 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#4b47e0">✓ 已选</text>}
            </g>
          );
        })}
      </svg>
      <div className="shock-timeline-legend">
        <span>○ 宣布/解除</span><span>● 生效</span>
        {SHOCK_TYPES.map((key) => (
          <span key={key} style={{ color: SHOCK_TYPE_COLORS[key] }}>● {SHOCK_TYPE_LABELS[key]}</span>
        ))}
        <span>选择事件后会更新上方摘要与紧邻的冲击面板</span>
      </div>
    </div>
  );
}
