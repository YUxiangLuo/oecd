import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cardStyle, useTip } from "../shared";
import { niceDomain } from "../nice-ticks";
import { svgTextWidth } from "./charts";
import { NEGATIVE, POSITIVE, UNCERTAIN, ZERO_LINE } from "./palette";

/** One bar: a value in the chart's unit, its 95% interval (null: no whisker) and the text at its end. */
export interface DivergingBarRow {
  key: string;
  label: string;
  /** A smaller second line under the label (the step and family on step 15, the native unit on step 13). */
  sublabel?: string;
  value: number;
  low: number | null;
  high: number | null;
  /** The interval includes 0 (or is missing or suppressed): grey bar and "方向不确定" after the value. */
  uncertain: boolean;
  selected?: boolean;
  valueLabel: string;
  /** Tooltip only: the interval in words, and a note such as "这次不显示 95% 区间". */
  intervalLabel?: string;
  note?: string;
}

export const UNCERTAIN_TEXT = "方向不确定";
const LABEL_SIZE = 12.5, SUB_SIZE = 11, VALUE_SIZE = 12, TAG_SIZE = 10.5;
const ROW_H = 42, BAR_H = 20, PAD_T = 10, AXIS_H = 44, GAP = 7, COLUMN_GAP = 16, EDGE = 10;
/** Narrowest and widest drawing widths: the chart is drawn at its container's width, so text keeps its size. */
export const MIN_WIDTH = 420, MAX_WIDTH = 980, DEFAULT_WIDTH = 680;
const CARD_PADDING_X = 16;

/** The text after a bar's end: its value, and "· 方向不确定" when the interval includes 0. */
export function endLabel(row: Pick<DivergingBarRow, "valueLabel" | "uncertain">): string {
  return row.uncertain ? `${row.valueLabel} · ${UNCERTAIN_TEXT}` : row.valueLabel;
}

const tagWidth = (tag: string) => svgTextWidth(tag, TAG_SIZE) + 12;

interface PlacedRow {
  row: DivergingBarRow;
  y: number;
  /** Bar from the zero line to the value. */
  x0: number;
  x1: number;
  whisker: [number, number] | null;
  /** End label: anchored at `labelX`, running away from 0 ("start" to the right, "end" to the left). */
  labelX: number;
  anchor: "start" | "end";
  labelWidth: number;
}

export interface DivergingLayout {
  width: number;
  height: number;
  /** Right edge of the fixed left column holding the row names. */
  columnRight: number;
  plotLeft: number;
  plotRight: number;
  zeroX: number;
  ticks: { value: number; x: number; text: string }[];
  rows: PlacedRow[];
}

/** A tick as written on the axis: trailing zeros trimmed, never "-0". */
function tickText(value: number): string {
  const text = String(Number(value.toPrecision(10)));
  return text === "-0" ? "0" : text;
}

/**
 * Where everything goes at a drawing width. The row names take a left column as wide as the longest one (so no
 * name is clipped); the plot is what remains. The scale is the largest one at which every bar, whisker and end
 * label fits: a label sits beyond the far end of its bar or whisker, on the side away from 0, so it can meet
 * neither the zero line nor the left column; one label per row and rows taller than the text keep labels apart.
 */
export function layoutDivergingBars(
  rows: DivergingBarRow[],
  width = DEFAULT_WIDTH,
  { highlight = "已保存", reserveTag = rows.some((row) => row.selected) }: { highlight?: string; reserveTag?: boolean } = {},
): DivergingLayout {
  // Room for the tag is kept on every row of a selectable chart, so the column does not jump when it moves.
  const nameWidth = Math.max(0, ...rows.map((row) => Math.max(
    svgTextWidth(row.label, LABEL_SIZE),
    (row.sublabel ? svgTextWidth(row.sublabel, SUB_SIZE) + 6 : 0) + (reserveTag ? tagWidth(highlight) : 0),
  )));
  const columnRight = EDGE + nameWidth;
  const plotLeft = columnRight + COLUMN_GAP, plotRight = width - EDGE;
  const span = Math.max(1, plotRight - plotLeft);
  const items = rows.map((row) => {
    const ends = [row.value, row.low, row.high, 0].filter((value): value is number => value != null && Number.isFinite(value));
    const labelWidth = svgTextWidth(endLabel(row), VALUE_SIZE);
    return { row, lo: Math.min(...ends), hi: Math.max(...ends), right: row.value >= 0, labelWidth };
  });
  // x(v) = zero + k·v. Every row asks zero ≥ plotLeft + need − k·lo and zero ≤ plotRight − need − k·hi, where
  // need is its label (plus a gap) on the side the label goes and 0 on the other.
  const bounds = (k: number) => {
    let low = plotLeft, high = plotRight;
    for (const item of items) {
      low = Math.max(low, plotLeft + (item.right ? 0 : item.labelWidth + GAP) - k * item.lo);
      high = Math.min(high, plotRight - (item.right ? item.labelWidth + GAP : 0) - k * item.hi);
    }
    return { low, high };
  };
  let lo = 0, hi = span / Math.max(1e-12, ...items.map((item) => item.hi - item.lo));
  for (let step = 0; step < 60; step++) {
    const mid = (lo + hi) / 2;
    const { low, high } = bounds(mid);
    if (low <= high) lo = mid; else hi = mid;
  }
  // A little air beyond the longest label; the zero line goes in the middle of the room that leaves.
  const k = Math.max(lo * 0.96, 1e-12);
  const room = bounds(k);
  const zeroX = room.low <= room.high ? (room.low + room.high) / 2 : Math.min(Math.max(room.low, plotLeft), plotRight);
  const x = (value: number) => zeroX + k * value;
  const visible = niceDomain((plotLeft - zeroX) / k, (plotRight - zeroX) / k, Math.max(2, Math.round(span / 110)));
  const ticks = visible.ticks
    .filter((value) => x(value) >= plotLeft - 0.5 && x(value) <= plotRight + 0.5)
    .map((value) => ({ value, x: x(value), text: tickText(value) }));
  return {
    width,
    height: PAD_T + rows.length * ROW_H + AXIS_H,
    columnRight,
    plotLeft,
    plotRight,
    zeroX,
    ticks,
    rows: items.map((item, index) => {
      const whisker: [number, number] | null = item.row.low != null && item.row.high != null ? [x(item.row.low), x(item.row.high)] : null;
      return {
        row: item.row,
        y: PAD_T + (index + 0.5) * ROW_H,
        x0: Math.min(zeroX, x(item.row.value)),
        x1: Math.max(zeroX, x(item.row.value)),
        whisker,
        labelX: item.right ? x(item.hi) + GAP : x(item.lo) - GAP,
        anchor: item.right ? "start" : "end",
        labelWidth: item.labelWidth,
      };
    }),
  };
}

/** The axis title is centred under the plot, or under the whole drawing when it is wider than the plot. */
export function unitTitleX(layout: Pick<DivergingLayout, "plotLeft" | "plotRight" | "width">, text: string): number {
  const half = svgTextWidth(text, 11.5) / 2;
  const centre = (layout.plotLeft + layout.plotRight) / 2;
  return Math.min(Math.max(centre, half + 2), layout.width - half - 2);
}

/** A horizontal bar from the zero line, square there and with 4px rounded corners at its data end. */
function barPath(x0: number, x1: number, y: number, towardRight: boolean): string {
  const top = y - BAR_H / 2, bottom = y + BAR_H / 2;
  const r = Math.min(4, (x1 - x0) / 2);
  if (r <= 0) return `M${x0},${top}H${x1}V${bottom}H${x0}Z`;
  return towardRight
    ? `M${x0},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${bottom - r}Q${x1},${bottom} ${x1 - r},${bottom}H${x0}Z`
    : `M${x1},${top}H${x0 + r}Q${x0},${top} ${x0},${top + r}V${bottom - r}Q${x0},${bottom} ${x0 + r},${bottom}H${x1}Z`;
}

export function barColor(row: Pick<DivergingBarRow, "uncertain" | "value">): string {
  return row.uncertain ? UNCERTAIN : row.value < 0 ? NEGATIVE : POSITIVE;
}

/** The container's width, so the chart is drawn at 1:1 and its text keeps its size at 1024 and 1280 px windows. */
function useDrawingWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // clientWidth includes the card's 16px side padding; the drawing gets what is inside it.
      const inner = element.clientWidth - 2 * CARD_PADDING_X;
      if (inner > 0) setWidth(Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, inner))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Diverging horizontal bars: one row per Y, a vertical zero line, positive bars to the right in red, negative to
 * the left in blue, grey where the 95% interval (the thin whisker) includes 0. The selected row (the saved Y) is
 * outlined and tagged. With `onSelect` each row is a button (Enter/Space selects, arrow keys move); without it
 * the chart is one image with its values in the label.
 */
export function DivergingBarChart({
  rows, unitTitle, title, onSelect, disabled = false, highlight = "已保存", width: fixedWidth,
}: {
  rows: DivergingBarRow[];
  /** The axis title, naming the unit ("X 每高 1 个百分点，Y 平均相差（个标准差）"). */
  unitTitle: string;
  title?: string;
  onSelect?: (key: string) => void;
  /** While a run is in flight: rows cannot be selected. */
  disabled?: boolean;
  /** The tag beside the selected row's name. */
  highlight?: string;
  /** A fixed drawing width (the report and tests); otherwise the container's width. */
  width?: number;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const measured = useDrawingWidth(wrapRef);
  const interactive = Boolean(onSelect);
  const layout = layoutDivergingBars(rows, fixedWidth ?? measured, { highlight, reserveTag: interactive || rows.some((row) => row.selected) });
  const rowRefs = useRef<(SVGGElement | null)[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const tabRow = Math.max(0, rows.findIndex((row) => row.selected));
  const spoken = (row: DivergingBarRow) => `${row.label}：${endLabel(row).replace(" · ", "，")}${row.selected ? `，${highlight}` : ""}`;
  const summary = `${title ? `${title}；` : ""}${unitTitle}。${rows.map(spoken).join("；")}`;
  const tip = (row: DivergingBarRow): [string, string][] => [
    ["", row.label],
    ["估计值", row.valueLabel],
    ["95% 区间", row.intervalLabel ?? "—"],
    ...(row.note ? [["说明", row.note] as [string, string]] : []),
    ...(interactive && !row.selected ? [["操作", "点一下，换成这个 Y 并保存"] as [string, string]] : []),
  ];
  const move = (index: number) => rowRefs.current[(index + rows.length) % rows.length]?.focus();
  const onKey = (event: KeyboardEvent<SVGGElement>, index: number, row: DivergingBarRow) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); move(index + 1); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); move(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); move(0); }
    else if (event.key === "End") { event.preventDefault(); move(rows.length - 1); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) onSelect?.(row.key);
    }
  };
  const present = new Set(rows.map((row) => barColor(row)));
  const legend = [
    { color: POSITIVE, text: "X 越高，Y 越高" },
    { color: NEGATIVE, text: "X 越高，Y 越低" },
    { color: UNCERTAIN, text: UNCERTAIN_TEXT },
  ].filter((item) => present.has(item.color));
  const plotBottom = PAD_T + rows.length * ROW_H;
  return (
    <div ref={wrapRef} className="diverging-bars" style={{ ...cardStyle, padding: `14px ${CARD_PADDING_X}px`, printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
      {title && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}</div>}
      <div className="diverging-bars-legend" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", margin: "4px 0 6px", fontSize: 11.5, color: "#5a6070" }}>
        {legend.map((item) => (
          <span key={item.color} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 3, background: item.color }} />{item.text}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span aria-hidden="true" style={{ width: 14, height: 0, borderTop: `1.5px solid ${ZERO_LINE}` }} />细线 = 95% 区间
        </span>
      </div>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role={interactive ? "group" : "img"}
        aria-label={summary}
        style={{ display: "block", width: "100%", height: "auto", overflow: "visible" }}
      >
        {layout.ticks.map((tick) => (
          <g key={tick.value} aria-hidden="true">
            {tick.value !== 0 && <line x1={tick.x} x2={tick.x} y1={PAD_T} y2={plotBottom} stroke="#eef0f4" strokeWidth={1} />}
            {/* A tick at the right edge is right-aligned there, so its text stays inside the drawing. */}
            <text x={tick.x} y={plotBottom + 16} textAnchor={tick.x > layout.plotRight - 16 ? "end" : "middle"} fontSize={11} fill="#5f6677">{tick.text}</text>
          </g>
        ))}
        <text aria-hidden="true" x={unitTitleX(layout, unitTitle)} y={layout.height - 6} textAnchor="middle" fontSize={11.5} fill="#3a4050">{unitTitle}</text>
        {layout.rows.map((placed, index) => {
          const { row, y } = placed;
          const towardRight = row.value >= 0;
          const twoLines = Boolean(row.sublabel) || Boolean(row.selected);
          const nameY = twoLines ? y - 7 : y;
          const tagX = layout.columnRight - tagWidth(highlight);
          return (
            <g
              key={row.key}
              ref={(node) => { rowRefs.current[index] = node; }}
              data-bar={row.key}
              data-selected={row.selected ? "true" : undefined}
              {...(interactive ? {
                role: "button",
                tabIndex: index === tabRow ? 0 : -1,
                "aria-pressed": Boolean(row.selected),
                "aria-disabled": disabled || undefined,
                "aria-label": spoken(row),
                onClick: () => { if (!disabled) onSelect?.(row.key); },
                onKeyDown: (event: KeyboardEvent<SVGGElement>) => onKey(event, index, row),
                onFocus: () => setFocused(row.key),
                onBlur: () => setFocused((current) => (current === row.key ? null : current)),
              } : {})}
              style={{ cursor: interactive ? (disabled ? "progress" : "pointer") : undefined, outline: "none" }}
              onMouseEnter={(event) => show(event, tip(row))}
              onMouseMove={(event) => show(event, tip(row))}
              onMouseLeave={hide}
            >
              {/* The whole row is the hit area; the selected one is tinted. */}
              <rect x={0} y={y - ROW_H / 2 + 1} width={layout.width} height={ROW_H - 2} rx={8} fill={row.selected ? "#f3f4fa" : "transparent"} />
              {focused === row.key && <rect x={1} y={y - ROW_H / 2 + 1} width={layout.width - 2} height={ROW_H - 2} rx={8} fill="none" stroke="#4b47e0" strokeWidth={2} strokeDasharray="4 3" />}
              <text x={layout.columnRight} y={nameY} dominantBaseline="middle" textAnchor="end" fontSize={LABEL_SIZE} fontWeight={row.selected ? 700 : 500} fill="#2a2f3a">{row.label}</text>
              {twoLines && (
                <g aria-hidden="true">
                  {row.sublabel && (
                    <text x={row.selected ? tagX - 6 : layout.columnRight} y={y + 10} dominantBaseline="middle" textAnchor="end" fontSize={SUB_SIZE} fill="#5f6677">{row.sublabel}</text>
                  )}
                  {row.selected && (
                    <g data-selected-tag>
                      <rect x={tagX} y={y + 3} width={tagWidth(highlight)} height={15} rx={7.5} fill={ZERO_LINE} />
                      <text x={tagX + tagWidth(highlight) / 2} y={y + 10.5} dominantBaseline="middle" textAnchor="middle" fontSize={TAG_SIZE} fontWeight={700} fill="#fff">{highlight}</text>
                    </g>
                  )}
                </g>
              )}
              <path
                d={barPath(placed.x0, placed.x1, y, towardRight)}
                fill={barColor(row)}
                stroke={row.selected ? ZERO_LINE : "none"}
                strokeWidth={row.selected ? 2 : 0}
              />
              {placed.whisker && (
                <g data-whisker stroke="#3a4050" strokeWidth={1.4}>
                  <line x1={placed.whisker[0]} x2={placed.whisker[1]} y1={y} y2={y} />
                  <line x1={placed.whisker[0]} x2={placed.whisker[0]} y1={y - 5} y2={y + 5} />
                  <line x1={placed.whisker[1]} x2={placed.whisker[1]} y1={y - 5} y2={y + 5} />
                </g>
              )}
              <text data-end-label x={placed.labelX} y={y} dominantBaseline="middle" textAnchor={placed.anchor} fontSize={VALUE_SIZE} fill="#2a2f3a">
                <tspan fontWeight={700}>{row.valueLabel}</tspan>
                {row.uncertain && <tspan fill="#5f6677">{` · ${UNCERTAIN_TEXT}`}</tspan>}
              </text>
            </g>
          );
        })}
        <line x1={layout.zeroX} x2={layout.zeroX} y1={PAD_T - 4} y2={plotBottom} stroke={ZERO_LINE} strokeWidth={1.6} />
      </svg>
      {Tip}
    </div>
  );
}
