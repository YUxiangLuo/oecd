import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { cardStyle, useTip } from "../shared";
import { divergingAxis } from "../nice-ticks";
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
  /** Read aloud: the value with its unit and the 95% interval (barFigures); the end label when absent. */
  spokenLabel?: string;
}

/** A bar as read aloud: "外国增加值项占比：-0.55 个百分点，95% 区间 [-0.57, -0.53]，已保存". */
export function spokenBar(row: DivergingBarRow, highlight = "已保存"): string {
  const value = row.spokenLabel != null
    ? `${row.spokenLabel}${row.uncertain ? `，${UNCERTAIN_TEXT}` : ""}`
    : endLabel(row).replace(" · ", "，");
  return `${row.label}：${value}${row.selected ? `，${highlight}` : ""}`;
}

export const UNCERTAIN_TEXT = "方向不确定";
/** The saved bar's tooltip line: it is the Y the report uses, so clicking it does nothing. */
export const SAVED_TIP = "已保存（报告用这个 Y）";
export const SELECT_TIP = "点击即改为保存此 Y";
const LABEL_SIZE = 12.5, SUB_SIZE = 11, VALUE_SIZE = 12, TAG_SIZE = 10.5;
const ROW_H = 42, LINE_H = 15, BAR_H = 20, PAD_T = 10, AXIS_H = 44, GAP = 7, COLUMN_GAP = 16, EDGE = 10;
/** Narrowest and widest drawing widths: the chart is drawn at its container's width, so text keeps its size. */
export const MIN_WIDTH = 420, MAX_WIDTH = 980, DEFAULT_WIDTH = 680;
const CARD_PADDING_X = 16;

/** The text after a bar's end: its value, and "· 方向不确定" when the interval includes 0. */
export function endLabel(row: Pick<DivergingBarRow, "valueLabel" | "uncertain">): string {
  return row.uncertain ? `${row.valueLabel} · ${UNCERTAIN_TEXT}` : row.valueLabel;
}

/**
 * The end label on one, two or three lines (layout 0–2), as the report draws it: "-40.11 个中心性原始单位" /
 * "（-0.047 个标准差）" / "方向不确定". Where one line leaves the bars too short (long labels on both sides of the
 * zero line in a narrow window), the labels are stacked instead.
 */
export function endLabelLines(row: Pick<DivergingBarRow, "valueLabel" | "uncertain">, layout: number): string[] {
  if (layout <= 0) return [endLabel(row)];
  const bracket = row.valueLabel.indexOf("（");
  const [native, standardized] = bracket > 0
    ? [row.valueLabel.slice(0, bracket).trimEnd(), row.valueLabel.slice(bracket)]
    : [row.valueLabel, ""];
  const uncertain = row.uncertain ? UNCERTAIN_TEXT : "";
  if (layout === 1) {
    const second = [standardized, uncertain].filter(Boolean).join(" · ");
    return second ? [native, second] : [native];
  }
  return [native, standardized, uncertain].filter(Boolean);
}

const tagWidth = (tag: string) => svgTextWidth(tag, TAG_SIZE) + 12;

interface PlacedRow {
  row: DivergingBarRow;
  y: number;
  /** The row's height: taller when its end label is stacked on two or three lines. */
  height: number;
  /** Bar from the zero line to the value. */
  x0: number;
  x1: number;
  whisker: [number, number] | null;
  /** End label: anchored at `labelX`, running away from 0 ("start" to the right, "end" to the left). */
  labelX: number;
  anchor: "start" | "end";
  /** The width of its widest line. */
  labelWidth: number;
  lines: string[];
}

export interface DivergingLayout {
  /** The drawing's width (viewBox): the width asked for, unless even stacked labels leave the bars no room. */
  width: number;
  height: number;
  /** Right edge of the fixed left column holding the row names. */
  columnRight: number;
  plotLeft: number;
  plotRight: number;
  zeroX: number;
  /** End labels on one line (0), as value / standard deviations (1), or on three lines (2). */
  labelLayout: number;
  ticks: { value: number; x: number; text: string }[];
  rows: PlacedRow[];
}

/** A tick as written on the axis: trailing zeros trimmed, never "-0". */
function tickText(value: number): string {
  const text = String(Number(value.toPrecision(10)));
  return text === "-0" ? "0" : text;
}

const finiteEnds = (row: DivergingBarRow) =>
  [row.value, row.low, row.high, 0].filter((value): value is number => value != null && Number.isFinite(value));

/**
 * Where everything goes at a drawing width. The row names take a left column as wide as the longest one (so no
 * name is clipped); the plot is what remains. The scale is the largest one at which every bar, whisker and end
 * label fits, and the axis range (divergingAxis: from the data alone, as in the report) too: a label sits beyond the far end of its bar or whisker, on the side away from 0, so it can meet
 * neither the zero line nor the left column; one label per row and rows taller than the text keep labels apart.
 *
 * End labels stay on one line while the longest bar still gets a third of the plot; otherwise they are stacked on
 * two, then three lines; when none of these gives a third, the one with the longest bars is used, as in the report
 * (report-renderer.tsx), and the drawing keeps the container's width. Only when the bars would get less than a sixth
 * (far below the supported window width) is the drawing made wider, so the chart scales down as a whole instead of
 * collapsing its bars.
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
  const plotLeft = columnRight + COLUMN_GAP;
  const extent = Math.max(1e-12, ...rows.flatMap(finiteEnds).map(Math.abs));
  // The axis range comes from the data alone (as in the report), so it is the same at every width; the scale is
  // chosen so both of its ends are inside the plot.
  const range = divergingAxis(rows.flatMap(finiteEnds), 4);
  const itemsAt = (labelLayout: number) => rows.map((row) => {
    const ends = finiteEnds(row);
    const lines = endLabelLines(row, labelLayout);
    const labelWidth = Math.max(...lines.map((line) => svgTextWidth(line, VALUE_SIZE)));
    return { row, lo: Math.min(...ends), hi: Math.max(...ends), right: row.value >= 0, labelWidth, lines };
  });
  const attempt = (drawWidth: number, labelLayout: number) => {
    const plotRight = drawWidth - EDGE;
    const span = Math.max(1, plotRight - plotLeft);
    const items = itemsAt(labelLayout);
    // x(v) = zero + k·v. Every row asks zero ≥ plotLeft + need − k·lo and zero ≤ plotRight − need − k·hi, where
    // need is its label (plus a gap) on the side the label goes and 0 on the other.
    const bounds = (k: number) => {
      let low = plotLeft - k * range.lo, high = plotRight - k * range.hi;
      for (const item of items) {
        low = Math.max(low, plotLeft + (item.right ? 0 : item.labelWidth + GAP) - k * item.lo);
        high = Math.min(high, plotRight - (item.right ? item.labelWidth + GAP : 0) - k * item.hi);
      }
      return { low, high };
    };
    // The labels alone are wider than the plot: no scale fits (this used to fall to k ≈ 0 and print ±2e14 ticks).
    const empty = bounds(0);
    if (empty.low > empty.high) return null;
    let lo = 0, hi = span / Math.max(1e-12, range.hi - range.lo, ...items.map((item) => item.hi - item.lo));
    for (let step = 0; step < 60; step++) {
      const mid = (lo + hi) / 2;
      const { low, high } = bounds(mid);
      if (low <= high) lo = mid; else hi = mid;
    }
    // A little air beyond the longest label.
    const k = lo * 0.96;
    if (!(k > 0)) return null;
    return { drawWidth, labelLayout, plotRight, span, items, k, room: bounds(k) };
  };
  type Fit = NonNullable<ReturnType<typeof attempt>>;
  const roomy = (fit: Fit | null): fit is Fit => fit != null && fit.k * extent >= fit.span / 3;
  // The report's rule (report-renderer.tsx): the first layout whose longest bar gets a third of the plot, else the one
  // with the longest bars. The drawing keeps the container's width, so its text keeps its size (a summary drawn 940
  // wide in a 680 card read at 7–8px).
  const usable = (fit: Fit | null): fit is Fit => fit != null && fit.k * extent >= fit.span / 6;
  const fits = [0, 1, 2].map((labelLayout) => attempt(width, labelLayout)).filter((item): item is Fit => item != null);
  const longest = fits.reduce<Fit | null>((best, item) => (best == null || item.k > best.k ? item : best), null);
  let fit: Fit | null = fits.find(roomy) ?? (usable(longest) ? longest : null);
  // Only far below the supported width (labels leave the bars almost nothing): draw wider, scaled down to the box.
  for (let wider = width + 20; !fit && wider <= width * 4; wider += 20) {
    const candidate = attempt(wider, 2);
    if (usable(candidate)) fit = candidate;
  }
  // Never reached with real labels (they would need a drawing four times as wide); the axis still stays finite.
  const chosen: Fit = fit ?? attempt(width * 4, 2) ?? (() => {
    const plotRight = width - EDGE;
    const span = Math.max(1, plotRight - plotLeft);
    const centre = (plotLeft + plotRight) / 2;
    return { drawWidth: width, labelLayout: 2, plotRight, span, items: itemsAt(2), k: span / (2 * extent), room: { low: centre, high: centre } };
  })();
  const { drawWidth, labelLayout, plotRight, items, k, room } = chosen;
  // The zero line goes in the middle of the room the labels leave.
  const zeroX = room.low <= room.high ? (room.low + room.high) / 2 : Math.min(Math.max(room.low, plotLeft), plotRight);
  const x = (value: number) => zeroX + k * value;
  // The data's range, with a tick per 110 px of it or so.
  const ticks = divergingAxis(rows.flatMap(finiteEnds), Math.round((k * (range.hi - range.lo)) / 110)).ticks
    .filter((value) => x(value) >= plotLeft - 0.5 && x(value) <= plotRight + 0.5)
    .map((value) => ({ value, x: x(value), text: tickText(value) }));
  const heights = items.map((item) => Math.max(ROW_H, item.lines.length * LINE_H + 14));
  const tops = heights.map((_, index) => PAD_T + heights.slice(0, index).reduce((sum, height) => sum + height, 0));
  return {
    width: drawWidth,
    height: PAD_T + heights.reduce((sum, height) => sum + height, 0) + AXIS_H,
    columnRight,
    plotLeft,
    plotRight,
    zeroX,
    labelLayout,
    ticks,
    rows: items.map((item, index) => {
      const whisker: [number, number] | null = item.row.low != null && item.row.high != null ? [x(item.row.low), x(item.row.high)] : null;
      return {
        row: item.row,
        y: tops[index] + heights[index] / 2,
        height: heights[index],
        x0: Math.min(zeroX, x(item.row.value)),
        x1: Math.max(zeroX, x(item.row.value)),
        whisker,
        labelX: item.right ? x(item.hi) + GAP : x(item.lo) - GAP,
        anchor: item.right ? "start" : "end",
        labelWidth: item.labelWidth,
        lines: item.lines,
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

/** The tooltip of one bar: its value and interval, and on a selectable chart what a click does (or that it is saved). */
export function barTip(row: DivergingBarRow, interactive: boolean, preview = false): [string, string][] {
  return [
    ["", row.label],
    ["估计值", row.valueLabel],
    ["95% 区间", row.intervalLabel ?? "—"],
    ...(row.note ? [["说明", row.note] as [string, string]] : []),
    ...(interactive ? [row.selected ? ["状态", preview ? "正在查看（不替换报告材料）" : SAVED_TIP] as [string, string] : ["操作", preview ? "点击预览此 Y，不替换报告材料" : SELECT_TIP] as [string, string]] : []),
  ];
}

/** One end-label line: the value in bold, "方向不确定" in muted grey after it. */
function EndLine({ line }: { line: string }) {
  const suffix = ` · ${UNCERTAIN_TEXT}`;
  if (line === UNCERTAIN_TEXT) return <tspan fill="#5f6677">{line}</tspan>;
  if (line.endsWith(suffix)) return <><tspan fontWeight={700}>{line.slice(0, -suffix.length)}</tspan><tspan fill="#5f6677">{suffix}</tspan></>;
  return <tspan fontWeight={700}>{line}</tspan>;
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
  rows, unitTitle, title, onSelect, disabled = false, highlight = "已保存", width: fixedWidth, children,
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
  /** Lines under the drawing, inside the card (step 12's identity, the notice after a bar replaced the saved Y). */
  children?: ReactNode;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const measured = useDrawingWidth(wrapRef);
  const interactive = Boolean(onSelect);
  const layout = layoutDivergingBars(rows, fixedWidth ?? measured, { highlight, reserveTag: interactive || rows.some((row) => row.selected) });
  const rowRefs = useRef<(SVGGElement | null)[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const tabRow = Math.max(0, rows.findIndex((row) => row.selected));
  // A saved Y can change without a click on the chart (a retry or 恢复默认 button); an open tooltip would still
  // describe the old state until the pointer moves.
  const savedKey = rows.find((row) => row.selected)?.key ?? null;
  useEffect(() => { hide(); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const spoken = (row: DivergingBarRow) => spokenBar(row, highlight);
  const summary = `${title ? `${title}；` : ""}${unitTitle}。${rows.map(spoken).join("；")}`;
  const move = (index: number) => rowRefs.current[(index + rows.length) % rows.length]?.focus();
  const select = (row: DivergingBarRow) => {
    if (disabled) return;
    // The tooltip was written for the row as it was; once the click saves it, it would still offer to save it.
    hide();
    onSelect?.(row.key);
  };
  const onKey = (event: KeyboardEvent<SVGGElement>, index: number, row: DivergingBarRow) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); move(index + 1); }
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); move(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); move(0); }
    else if (event.key === "End") { event.preventDefault(); move(rows.length - 1); }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(row);
    }
  };
  const present = new Set(rows.map((row) => barColor(row)));
  const legend = [
    { color: POSITIVE, text: "X 越高，Y 越高" },
    { color: NEGATIVE, text: "X 越高，Y 越低" },
    { color: UNCERTAIN, text: UNCERTAIN_TEXT },
  ].filter((item) => present.has(item.color));
  const plotBottom = layout.height - AXIS_H;
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
          const { row, y, height } = placed;
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
                onClick: () => select(row),
                onKeyDown: (event: KeyboardEvent<SVGGElement>) => onKey(event, index, row),
                // Keyboard focus shows the hover tooltip (its value and 95% interval) above the focused row, so it
                // never covers the lines under the chart (step 12's 合计 100% note, the axis title).
                onFocus: (event: FocusEvent<SVGGElement>) => {
                  setFocused(row.key);
                  const box = event.currentTarget.getBoundingClientRect();
                  show({ clientX: box.left + box.width * 0.55, clientY: box.top } as Parameters<typeof show>[0], barTip(row, interactive, highlight === "正在查看"), box);
                },
                onBlur: () => {
                  setFocused((current) => (current === row.key ? null : current));
                  hide();
                },
              } : {})}
              style={{ cursor: interactive ? (disabled ? "progress" : row.selected ? "default" : "pointer") : undefined, outline: "none" }}
              onMouseEnter={(event) => show(event, barTip(row, interactive, highlight === "正在查看"))}
              onMouseMove={(event) => show(event, barTip(row, interactive, highlight === "正在查看"))}
              onMouseLeave={hide}
            >
              {/* The whole row is the hit area; the selected one is tinted. */}
              <rect x={0} y={y - height / 2 + 1} width={layout.width} height={height - 2} rx={8} fill={row.selected ? "#f3f4fa" : "transparent"} />
              {focused === row.key && <rect x={1} y={y - height / 2 + 1} width={layout.width - 2} height={height - 2} rx={8} fill="none" stroke="#4b47e0" strokeWidth={2} strokeDasharray="4 3" />}
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
                {placed.lines.length === 1
                  ? <EndLine line={placed.lines[0]} />
                  : placed.lines.map((line, lineIndex) => (
                    // Stacked lines centred on the bar: the first one (n − 1) / 2 lines above it.
                    <tspan key={lineIndex} data-line x={placed.labelX} dy={lineIndex === 0 ? -((placed.lines.length - 1) * LINE_H) / 2 : LINE_H}>
                      <EndLine line={line} />
                    </tspan>
                  ))}
              </text>
            </g>
          );
        })}
        <line x1={layout.zeroX} x2={layout.zeroX} y1={PAD_T - 4} y2={plotBottom} stroke={ZERO_LINE} strokeWidth={1.6} pointerEvents="none" />
      </svg>
      {children}
      {Tip}
    </div>
  );
}
