import { ScrollableRegion } from "../../a11y";
import { niceDomain } from "../nice-ticks";
import { cjkSpace, formatMetric, stripNegativeZero } from "../../format";
import { CAT, KEY_ECONOMIES, Legend, type Row, cardStyle, num, rowLabel, rowName, useTip } from "../shared";
import { signedDomain, signedStack } from "../signed-layout";

/* ---------------- 步骤6-9 自由探索:排序条形图 / 散点图 ---------------- */

function fmtVal(v: number, format?: string): string {
  return formatMetric(v, format);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export interface ChartDataColumn {
  key: string;
  label: string;
}

/** One bounded keyboard entry exposes the exact rows already plotted without tabbing every mark. */
export function ChartDataDisclosure({ label, columns, rows }: {
  label: string;
  columns: readonly ChartDataColumn[];
  rows: readonly Record<string, string>[];
}) {
  return (
    <details className="chart-data-disclosure">
      <summary>{cjkSpace(cjkSpace("查看", label), "图表数据表")}</summary>
      {rows.length === 0 ? (
        <p className="muted" role="status">{label}当前没有可显示的有效数据。</p>
      ) : (
        <ScrollableRegion className="table-wrap chart-data-table-wrap" label={`${cjkSpace(label, "图表数据表")}，可横向滚动`}>
          <table className="data-table chart-data-table">
            <caption>{label}图表所绘制的完整数据</caption>
            <thead>
              <tr>{columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row[columns[0]?.key] ?? "row"}-${index}`}>
                  {columns.map((column, columnIndex) => columnIndex === 0
                    ? <th key={column.key} scope="row">{row[column.key]}</th>
                    : <td key={column.key}>{row[column.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableRegion>
      )}
    </details>
  );
}

/** 轴刻度专用:大数用「万/亿」缩写,避免出现 4,857,813 这类挤满轴的原始值 */
function fmtAxis(v: number, format?: string): string {
  // Ticks are round numbers: trim trailing zeros ("20%", "6", "1.5"), unlike readings, which keep fixed decimals.
  const displayed = format === "pct" ? v * 100 : v;
  if (displayed !== 0 && Math.abs(displayed) < (format === "pct" ? 0.01 : 0.001)) {
    return `${Number(displayed.toPrecision(6))}${format === "pct" ? "%" : ""}`;
  }
  if (format === "pct") return `${stripNegativeZero((v * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }))}%`;
  // Amounts are in 百万美元: "5万" there meant 5 万个百万美元 and was read as 5 万美元, so they keep full digits.
  if (format === "amount" || Math.abs(v) < 1e4) return stripNegativeZero(v.toLocaleString("zh-CN", { maximumFractionDigits: 3 }));
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}亿`;
  return `${(v / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}万`;
}

/** 轴范围:两端各留 6% 呼吸;全非负数据不让下界跌破 0(避免画出并不存在的负区间) */
function spreadDomain(arr: number[]): readonly [number, number] {
  if (!arr.length) return [0, 1] as const;
  const lo = Math.min(...arr), hi = Math.max(...arr);
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1;
  return [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad] as const;
}

/** Domain of log10(x) with one tick per power of ten (at least two ticks). */
function logDomain(values: number[]): { lo: number; hi: number; ticks: number[] } {
  const logs = values.filter((value) => value > 0).map((value) => Math.log10(value));
  if (!logs.length) return { lo: 0, hi: 1, ticks: [0, 1] };
  const lo = Math.floor(Math.min(...logs)), hi = Math.max(Math.ceil(Math.max(...logs)), lo + 1);
  const ticks: number[] = [];
  for (let tick = lo; tick <= hi; tick += 1) ticks.push(tick);
  return { lo, hi, ticks };
}

/** White-background selected-row text (dark amber, ~6:1 contrast); red is kept for negative values. */
export const RANK_HIGHLIGHT_TEXT = "#8a5a00";
/** Selected bars: amber, distinct from the ordinary blue bars and from the negative-value red. */
const RANK_HIGHLIGHT_FILL = CAT[2];
/** Context points on the scatter: every economy that is not selected. */
const REFERENCE_POINT = "#9aa3b5";

/** 任意指标的排序条形图(学生自选指标 + 对象后驱动) */
export function RankBarChart({ rows, metricKey, label, format, highlight, highlightColors }: {
  rows: Row[]; metricKey: string; label: string; format?: string; highlight?: Set<string>;
  /** Each selected economy's series colour, so its bar matches the dot strip and the other charts. */
  highlightColors?: Record<string, string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const data = rows
    .filter((row) => finite(row[metricKey]))
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .sort((first, second) => num(second.row[metricKey]) - num(first.row[metricKey]) || first.sourceIndex - second.sourceIndex)
    .map(({ row }) => row);
  const domain = signedDomain(data.map((row) => [num(row[metricKey])]), false);
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>{label} · 排序</div>
      {data.length === 0 ? <p className="muted" role="status">{label}当前没有可显示的有效数据。</p> : (
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {data.map((r) => {
          const v = num(r[metricKey]);
          const layout = signedStack([v], domain, false);
          const segment = layout.segments[0];
          // 非零极小值保留 1% 可见宽度；精确零不画条，负值向左扩。
          const widthPct = v === 0 ? 0 : Math.max(1, segment.widthPct);
          const leftPct = segment.negative ? layout.zeroPct - widthPct : segment.leftPct;
          const entity = rowName(r);
          const display = rowLabel(r);
          const hi = highlight?.has(entity);
          return (
            <div key={entity} data-selected={hi ? "true" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 10 }}
              onMouseMove={(e) => show(e, [["", display], [label, fmtVal(v, format)]])}
              onMouseLeave={hide}>
              <span title={display} style={{ width: 132, flexShrink: 0, fontSize: 11.5,
                color: hi ? (highlightColors ? "#1b1f2b" : RANK_HIGHLIGHT_TEXT) : "#5a6070", fontWeight: hi ? 700 : 400,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
              <div style={{ flex: 1, position: "relative", height: 16, background: "#f2f3f7", borderRadius: 5, overflow: "hidden" }}>
                {domain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 2, insetBlock: 0, left: `${layout.zeroPct}%`, borderLeft: "1.5px solid #4b5263" }} />}
                <div style={{
                  position: "absolute", top: 0, bottom: 0,
                  left: `${leftPct}%`, width: `${widthPct}%`,
                  background: segment.negative ? "#e34948" : hi ? highlightColors?.[entity] ?? RANK_HIGHLIGHT_FILL : highlightColors ? REFERENCE_POINT : CAT[0],
                  transition: "width .4s, left .4s",
                }} />
              </div>
              <span style={{ width: 76, textAlign: "right", fontSize: 11.5, fontFamily: "'Space Grotesk',sans-serif", color: "#3a4050" }}>{fmtVal(v, format)}</span>
            </div>
          );
        })}
      </div>
      )}
      <ChartDataDisclosure
        label={`${label}排序`}
        columns={[{ key: "entity", label: "对象" }, { key: "value", label }]}
        rows={data.map((row) => ({ entity: rowLabel(row), value: fmtVal(num(row[metricKey]), format) }))}
      />
      {Tip}
    </div>
  );
}

const median = (arr: number[]) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Fewer distinct points than this on a quadrant scatter and its medians and quadrants are not drawn or read. */
export const MIN_MEDIAN_POINTS = 5;

/**
 * Why a scatter's medians say nothing, or null when they are drawn: too few points, or too few distinct ones
 * (66 economies all at 0%, 0% are one position, and every one of them "equals the median"). `noun` counts the
 * points ("点", or "经济体" on the reading cards).
 */
export function medianSkipReason(points: { x: number; y: number }[], noun = "点"): string | null {
  const distinct = new Set(points.map((point) => `${point.x},${point.y}`)).size;
  if (distinct >= MIN_MEDIAN_POINTS) return null;
  if (points.length < MIN_MEDIAN_POINTS) return `图上只有 ${points.length} 个${noun}`;
  return distinct === 1 ? `图上 ${points.length} 个${noun}的读数相同` : `图上 ${points.length} 个${noun}只有 ${distinct} 个不同位置`;
}

type LabelBox = { x0: number; x1: number; y0: number; y1: number };
const boxesOverlap = (a: LabelBox, b: LabelBox) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Place point labels without collisions: highest priority first (selected, then key economies), trying
 * right, left, above, below and diagonally; a label also avoids the highlighted dots. If nothing fits, a
 * selected or key economy keeps the right-hand position and an ordinary one is left unlabelled.
 */
export function placeScatterLabels(
  labels: { id: string; text: string; x: number; y: number; priority: number }[],
  avoid: { x: number; y: number }[],
  bounds: { left: number; right: number; top: number; bottom: number },
) {
  const placed: LabelBox[] = [];
  const dots = avoid.map((dot) => ({ x0: dot.x - 7, x1: dot.x + 7, y0: dot.y - 7, y1: dot.y + 7 }));
  return [...labels].sort((a, b) => b.priority - a.priority).map((label) => {
    // Selected and key economies are bold capitals (about 7 units a letter); ordinary ones regular.
    const width = label.text.length * (label.priority > 0 ? 7 : 6.2);
    const candidates = [
      { x: label.x + 7, y: label.y + 3.5, anchor: "start" as const, box: { x0: label.x + 7, x1: label.x + 7 + width, y0: label.y - 5, y1: label.y + 5 } },
      { x: label.x - 7, y: label.y + 3.5, anchor: "end" as const, box: { x0: label.x - 7 - width, x1: label.x - 7, y0: label.y - 5, y1: label.y + 5 } },
      { x: label.x, y: label.y - 9, anchor: "middle" as const, box: { x0: label.x - width / 2, x1: label.x + width / 2, y0: label.y - 18, y1: label.y - 8 } },
      { x: label.x, y: label.y + 17, anchor: "middle" as const, box: { x0: label.x - width / 2, x1: label.x + width / 2, y0: label.y + 8, y1: label.y + 18 } },
      // Diagonals, for crowded clusters where the four sides are taken.
      { x: label.x + 6, y: label.y - 7, anchor: "start" as const, box: { x0: label.x + 6, x1: label.x + 6 + width, y0: label.y - 16, y1: label.y - 6 } },
      { x: label.x - 6, y: label.y - 7, anchor: "end" as const, box: { x0: label.x - 6 - width, x1: label.x - 6, y0: label.y - 16, y1: label.y - 6 } },
      { x: label.x + 6, y: label.y + 15, anchor: "start" as const, box: { x0: label.x + 6, x1: label.x + 6 + width, y0: label.y + 6, y1: label.y + 16 } },
      { x: label.x - 6, y: label.y + 15, anchor: "end" as const, box: { x0: label.x - 6 - width, x1: label.x - 6, y0: label.y + 6, y1: label.y + 16 } },
    ];
    const inside = (box: LabelBox) => box.x0 >= bounds.left && box.x1 <= bounds.right && box.y0 >= bounds.top && box.y1 <= bounds.bottom;
    const free = (box: LabelBox) => inside(box)
      && !placed.some((other) => boxesOverlap(box, other))
      && !dots.some((dot) => boxesOverlap(box, dot) && !(Math.abs((dot.x0 + dot.x1) / 2 - label.x) < 0.5 && Math.abs((dot.y0 + dot.y1) / 2 - label.y) < 0.5));
    const fitting = candidates.find((candidate) => free(candidate.box));
    // An ordinary economy's label is left out rather than drawn over another (its dot keeps its tooltip and
    // the data table); selected and key economies always keep theirs, where they overlap the fewest labels.
    if (!fitting && label.priority === 0) return null;
    const overlaps = (box: LabelBox) => (inside(box) ? 0 : 100) + placed.filter((other) => boxesOverlap(box, other)).length;
    const choice = fitting ?? candidates.reduce((best, candidate) => (overlaps(candidate.box) < overlaps(best.box) ? candidate : best));
    placed.push(choice.box);
    return { id: label.id, text: label.text, x: choice.x, y: choice.y, anchor: choice.anchor, box: choice.box };
  }).filter((label): label is NonNullable<typeof label> => label !== null);
}

/** A tick label centred on its tick unless that would cut it at the SVG edge ("10,000,000" at the right end
 *  of a log axis): then it ends (or starts) at the tick, so no label is clipped at any rendered width. */
export function xTickAnchor(x: number, text: string, width: number): "start" | "middle" | "end" {
  // Digits and separators are about 6 units wide at 10.5px; a CJK character (万/亿) about 10.5.
  const half = [...text].reduce((sum, char) => sum + (/[\u3000-\u9fff]/.test(char) ? 10.5 : 6.2), 0) / 2;
  if (x + half > width - 2) return "end";
  if (x - half < 2) return "start";
  return "middle";
}

/** Rough box of a 10.5-unit corner label: CJK characters are square, Latin and digits about half. */
function cornerLabelBox(text: string, x: number, y: number, anchor: "start" | "end"): LabelBox {
  const width = [...text].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 10.5 : 6), 0);
  return anchor === "end"
    ? { x0: x - width, x1: x, y0: y - 10, y1: y + 3 }
    : { x0: x, x1: x + width, y0: y - 10, y1: y + 3 };
}

/** Whether the segment from a to b passes through the box (sampled; the plot is a few hundred units wide). */
function segmentCrossesBox(a: { x: number; y: number }, b: { x: number; y: number }, box: LabelBox, pad = 3): boolean {
  for (let i = 0; i <= 80; i += 1) {
    const x = a.x + ((b.x - a.x) * i) / 80;
    const y = a.y + ((b.y - a.y) * i) / 80;
    if (x >= box.x0 - pad && x <= box.x1 + pad && y >= box.y0 - pad && y <= box.y1 + pad) return true;
  }
  return false;
}

/**
 * A corner label that the equal-length line would run through (the line meets the top-right and bottom-left
 * corners when both axes share a range), or that would cover a selected dot or a point label (`avoid`), moves
 * down or up along its edge, or inward, to the nearest clear place inside its own quadrant. When there is none
 * it stays in its corner with `clear: false` and is drawn behind the points.
 */
export function placeCornerLabel(
  text: string,
  corner: { x: number; y: number; anchor: "start" | "end" },
  line: { from: { x: number; y: number }; to: { x: number; y: number } } | null,
  bounds: { left: number; right: number; top: number; bottom: number },
  avoid: readonly LabelBox[] = [],
  quadrant: { left: number; right: number; top: number; bottom: number } = bounds,
): { x: number; y: number; clear: boolean } {
  const clear = (x: number, y: number, area: typeof bounds) => {
    const box = cornerLabelBox(text, x, y, corner.anchor);
    return box.x0 >= area.left && box.x1 <= area.right && box.y0 >= area.top && box.y1 <= area.bottom
      && !(line && segmentCrossesBox(line.from, line.to, box))
      && !avoid.some((other) => boxesOverlap(box, other));
  };
  if (clear(corner.x, corner.y, bounds)) return { x: corner.x, y: corner.y, clear: true };
  const down = corner.y < (bounds.top + bounds.bottom) / 2 ? 1 : -1;
  const inward = corner.anchor === "end" ? -1 : 1;
  for (let step = 1; step <= 24; step += 1) {
    if (clear(corner.x, corner.y + down * step * 6, quadrant)) return { x: corner.x, y: corner.y + down * step * 6, clear: true };
    if (clear(corner.x + inward * step * 6, corner.y, quadrant)) return { x: corner.x + inward * step * 6, y: corner.y, clear: true };
  }
  return { x: corner.x, y: corner.y, clear: false };
}

/** 象限散点图:两条参考线(默认中位数)把平面切成四象限,四角标注角色。
 *  步6「定位图」(外国增加值项占比×跨境生产占比)等双指标比较。 */
/** A highlighted economy's path through the years on the scatter (phase 2 定位图 轨迹). */
export interface ScatterTrail { id: string; label: string; color: string; points: { year: number; x: number; y: number }[] }

export function QuadrantScatter({ rows, referenceRows, xKey, yKey, xLabel, yLabel, xFormat, yFormat, highlight, highlightColors, refMode = "median", quadrantLabels, equalityLine = false, xScale = "linear", trails = [], dataLabel }: {
  rows: Row[]; xKey: string; yKey: string; xLabel: string; yLabel: string;
  /** Names the data table when one page draws several of these (one per country), so their names differ. */
  dataLabel?: string;
  referenceRows?: Row[];
  xFormat?: string; yFormat?: string; highlight?: Set<string>;
  /** Each selected economy's series colour, so its dot matches its trail and the other charts. */
  highlightColors?: Record<string, string>;
  refMode?: "median" | "mean"; quadrantLabels?: [string, string, string, string];
  /** Draw y=x when both axes share a unit (e.g. forward vs backward length). */
  equalityLine?: boolean;
  /** Log scale for size-like x metrics (amounts); points with x ≤ 0 are left out. */
  xScale?: "linear" | "log";
  trails?: ScatterTrail[];
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const W = 660, H = 400, m = { l: 62, r: 18, t: 14, b: 46 };
  const log = xScale === "log";
  const usable = (row: Row) => finite(row[xKey]) && finite(row[yKey]) && (!log || num(row[xKey]) > 0);
  const pts = rows.filter(usable).map((r) => ({
    c: rowName(r), label: rowLabel(r), tag: r.industry != null ? String(r.industry) : String(r.country),
    x: num(r[xKey]), y: num(r[yKey]),
  }));
  const requestedReferencePts = (referenceRows ?? rows)
    .filter(usable)
    .map((r) => ({ x: num(r[xKey]), y: num(r[yKey]) }));
  const referencePts = requestedReferencePts.length ? requestedReferencePts : pts;
  const trailPts = trails.flatMap((trail) => trail.points.filter((point) => !log || point.x > 0));
  const xs = [...referencePts.map((p) => p.x), ...trailPts.map((p) => p.x)], ys = [...referencePts.map((p) => p.y), ...trailPts.map((p) => p.y)];
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const tx = (x: number) => (log ? Math.log10(x) : x);
  const xAxis = log ? logDomain(xs) : niceDomain(...spreadDomain(xs)), yAxis = niceDomain(...spreadDomain(ys));
  const [x0, x1] = [xAxis.lo, xAxis.hi], [y0, y1] = [yAxis.lo, yAxis.hi];
  const px = (x: number) => m.l + ((tx(x) - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const py = (y: number) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  // Medians of a handful of points carry no information (of two points one is always "above"), nor do medians
  // of points that all sit in one place: then the reference lines and quadrant labels are left out.
  const skipReference = medianSkipReason(referencePts);
  const showReference = skipReference === null;
  // The axis title says the x axis is logarithmic; a reading is a plain amount.
  const xTipLabel = xLabel.replace(/，对数）$/, "）").replace(/（对数）$/, "");
  const referenceXs = referencePts.map((p) => p.x);
  const xRef = refMode === "mean" ? avg(referenceXs) : median(referenceXs);
  const yRef = refMode === "mean" ? avg(referencePts.map((p) => p.y)) : median(referencePts.map((p) => p.y));
  const showLabels = pts.length <= 24;
  // 四角标签坐标:[右上, 左上, 左下, 右下]
  const corners: { x: number; y: number; anchor: "start" | "end" }[] = [
    { x: W - m.r - 6, y: m.t + 12, anchor: "end" },
    { x: m.l + 6, y: m.t + 12, anchor: "start" },
    { x: m.l + 6, y: H - m.b - 8, anchor: "start" },
    { x: W - m.r - 6, y: H - m.b - 8, anchor: "end" },
  ];
  // The equal-length line in pixels, so a corner label it would cross ("前后向均较高") moves out of its way.
  const equalityPixels = equalityLine && !log && Math.max(x0, y0) < Math.min(x1, y1)
    ? { from: { x: px(Math.max(x0, y0)), y: py(Math.max(x0, y0)) }, to: { x: px(Math.min(x1, y1)), y: py(Math.min(x1, y1)) } }
    : null;
  const plotBounds = { left: m.l, right: W - m.r, top: m.t, bottom: H - m.b };
  const highlightedDots = pts.filter((p) => highlight?.has(p.c)).map((p) => ({ x: px(p.x), y: py(p.y) }));
  const pointLabels = placeScatterLabels(
    pts.filter((p) => showLabels || highlight?.has(p.c) || KEY_ECONOMIES.has(p.tag))
      .map((p) => ({ id: p.c, text: p.tag, x: px(p.x), y: py(p.y), priority: highlight?.has(p.c) ? 2 : KEY_ECONOMIES.has(p.tag) ? 1 : 0 })),
    highlightedDots,
    plotBounds,
  );
  // Corner labels keep clear of the selected dots and every point label (a USA label under "两项均较低" could
  // not be read); one that finds no clear place in its quadrant is drawn behind the points instead.
  const cornerAvoid = [...highlightedDots.map((dot) => ({ x0: dot.x - 7, x1: dot.x + 7, y0: dot.y - 7, y1: dot.y + 7 })), ...pointLabels.map((label) => label.box)];
  const refX = px(xRef), refY = py(yRef);
  const quadrantBounds = [
    { left: refX, right: W - m.r, top: m.t, bottom: refY },
    { left: m.l, right: refX, top: m.t, bottom: refY },
    { left: m.l, right: refX, top: refY, bottom: H - m.b },
    { left: refX, right: W - m.r, top: refY, bottom: H - m.b },
  ];
  const cornerLabels = showReference && quadrantLabels
    ? quadrantLabels.map((lab, i) => ({ lab, i, at: placeCornerLabel(lab, corners[i], equalityPixels, plotBounds, cornerAvoid, quadrantBounds[i]) }))
    : [];
  const cornerText = ({ lab, i, at }: (typeof cornerLabels)[number]) => (
    <text key={i} data-corner={i} data-behind={at.clear ? undefined : "true"} x={at.x} y={at.y} textAnchor={corners[i].anchor} pointerEvents="none"
      stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
      fontSize="10.5" fill="#5f6677" fontWeight={600}>{lab}</text>
  );
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>横轴 {xLabel} · 纵轴 {yLabel}</div>
      {/* The plot is capped like the trend chart: drawn much wider than 660 units, its 10.5-unit labels grew past the page text. */}
      {pts.length === 0 ? <p className="muted" role="status">横轴 {xLabel} · 纵轴 {yLabel} 当前没有可显示的有效数据。</p> : (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 780, margin: "0 auto" }}>
        {yAxis.ticks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={m.l} y1={py(t)} x2={W - m.r} y2={py(t)} stroke="#eef0f5" strokeWidth={1} />
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#5f6677">{fmtAxis(t, yFormat)}</text>
          </g>
        ))}
        {xAxis.ticks.map((t, i) => {
          const x = log ? px(10 ** t) : px(t);
          const text = fmtAxis(log ? 10 ** t : t, xFormat);
          return <text key={`x${i}`} x={x} y={H - m.b + 18} textAnchor={xTickAnchor(x, text, W)} fontSize="10.5" fill="#5f6677">{text}</text>;
        })}
        {/* 象限参考线(中位数) */}
        {showReference && <line x1={px(xRef)} y1={m.t} x2={px(xRef)} y2={H - m.b} stroke="#c8ccd6" strokeWidth={1} strokeDasharray="4 4" />}
        {showReference && <line x1={m.l} y1={py(yRef)} x2={W - m.r} y2={py(yRef)} stroke="#c8ccd6" strokeWidth={1} strokeDasharray="4 4" />}
        {equalityLine && !log && (() => {
          const lo = Math.max(x0, y0);
          const hi = Math.min(x1, y1);
          return lo < hi ? (
            <line x1={px(lo)} y1={py(lo)} x2={px(hi)} y2={py(hi)} stroke="#e0982a" strokeWidth={1.5} strokeDasharray="7 4">
              <title>等长线（前向 = 后向）；线上方更偏上游，线下方更偏下游</title>
            </line>
          ) : null;
        })()}
        {/* 轴标题 */}
        <text x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle" fontSize="11.5" fill="#5a6070">{xLabel}</text>
        <text x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" fontSize="11.5" fill="#5a6070"
          transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{yLabel}</text>
        {/* A corner label with no clear place gives way: drawn before the points, they and their labels cover it. */}
        {cornerLabels.filter(({ at }) => !at.clear).map(cornerText)}
        {/* Highlighted points are drawn last so ordinary points never cover them. */}
        {[...pts].sort((a, b) => Number(highlight?.has(a.c) ?? false) - Number(highlight?.has(b.c) ?? false)).map((p) => {
          const hi = highlight?.has(p.c);
          return (
            <g key={p.c}
              onMouseMove={(e) => show(e, [["", p.label], [xTipLabel, fmtVal(p.x, xFormat)], [yLabel, fmtVal(p.y, yFormat)]])}
              onMouseLeave={hide} style={{ cursor: "pointer" }}>
              <circle cx={px(p.x)} cy={py(p.y)} r={hi ? 6 : 4.5}
                fill={hi ? highlightColors?.[p.c] ?? RANK_HIGHLIGHT_FILL : REFERENCE_POINT} fillOpacity={hi ? 0.95 : 0.7} stroke="#fff" strokeWidth={1} />
            </g>
          );
        })}
        {trails.map((trail) => {
          const points = trail.points.filter((point) => !log || point.x > 0);
          if (points.length < 2) return null;
          return (
            <g key={`trail-${trail.id}`} data-trail={trail.id}>
              <polyline points={points.map((point) => `${px(point.x)},${py(point.y)}`).join(" ")} fill="none" stroke={trail.color} strokeWidth={2} strokeLinejoin="round" strokeOpacity={0.9} />
              {points.map((point, index) => (
                <g key={point.year} onMouseMove={(e) => show(e, [["", `${trail.label} · ${point.year}`], [xTipLabel, fmtVal(point.x, xFormat)], [yLabel, fmtVal(point.y, yFormat)]])} onMouseLeave={hide}>
                  <circle cx={px(point.x)} cy={py(point.y)} r={index === 0 || index === points.length - 1 ? 4 : 2.5} fill={index === 0 ? "#fff" : trail.color} stroke={trail.color} strokeWidth={1.5} />
                </g>
              ))}
              {/* No per-trail "2016→2020" text: placed outside the label layout it overlapped the country labels.
                  The note above the chart explains hollow start / solid end, and each point's tooltip names its year. */}
            </g>
          );
        })}
        {pointLabels.map((label) => {
          const hi = highlight?.has(label.id);
          const key = KEY_ECONOMIES.has(label.text);
          return (
            <text key={`label-${label.id}`} x={label.x} y={label.y} textAnchor={label.anchor} fontSize="10" pointerEvents="none"
              stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
              fill={hi ? "#1b1f2b" : key ? "#3a4050" : "#5f6677"} fontWeight={hi || key ? 700 : 400}>{label.text}</text>
          );
        })}
        {/* 四角角色标签：有空位时画在点之上，白色描边保证可读 */}
        {cornerLabels.filter(({ at }) => at.clear).map(cornerText)}
      </svg>
      )}
      {equalityLine && pts.length > 0 && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}><span style={{ color: "var(--text-warning)", fontWeight: 700 }}>橙色虚线是等长线（前向 = 后向）</span>：线上方前向 GVC 段更长（GVC 位置指数 &gt; 1，更偏上游）；线下方更偏下游。{showReference && "灰色虚线是中位数，只表示相对高低。"}</div>}
      {pts.length > 0 && !showReference && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{skipReference}，不画中位数和象限。</div>}
      <ChartDataDisclosure
        label={`${dataLabel ? `${dataLabel} · ` : ""}${yLabel}与${xLabel}散点`}
        columns={[{ key: "entity", label: "对象" }, { key: "x", label: xLabel }, { key: "y", label: yLabel }]}
        rows={pts.map((point) => ({ entity: point.label, x: fmtVal(point.x, xFormat), y: fmtVal(point.y, yFormat) }))}
      />
      {Tip}
    </div>
  );
}

/** 构成条:指标驱动、可排序的横向堆叠条(步9 生产构成 / 步10 长度共用)。
 *  normalize=true 每条=分段和的 100%(步8 出口来源、步9 生产构成);
 *  normalize=false 用全局最大值的绝对宽度(步10 生产链长度)。 */
export interface CompositionSegment {
  key: string;
  name: string;
  /** Optional explicit palette binding; other charts retain their fixed CAT slot fallback. */
  color?: string;
}

export const NEGATIVE_COMPOSITION_STYLE = {
  name: "负分项（零轴左侧）",
  colorName: "红色",
  color: "#e34948",
} as const;

export function compositionSegmentColor(
  segment: CompositionSegment,
  index: number,
  negative: boolean,
): string {
  return negative ? NEGATIVE_COMPOSITION_STYLE.color : (segment.color ?? CAT[index]);
}

export type CompositionSortDirection = "ascending" | "descending" | "input";

export function sortCompositionRows(
  rows: readonly Row[],
  sortKey: string,
  direction: CompositionSortDirection = "descending",
): Row[] {
  if (direction === "input") return [...rows];
  const sign = direction === "descending" ? -1 : 1;
  return [...rows].sort((first, second) => sign * (num(first[sortKey]) - num(second[sortKey])));
}

export function CompositionBar({ rows, segments, sortKey, sortDirection = "descending", sortLabel, sortFormat, normalize = true, normalizationKey, valueFormat = "pct", highlight, dataLabel }: {
  rows: Row[]; segments: readonly CompositionSegment[]; sortKey?: string;
  sortDirection?: CompositionSortDirection; sortLabel?: string; sortFormat?: string;
  normalize?: boolean; normalizationKey?: string; valueFormat?: string; highlight?: Set<string>;
  /** Names the data table when one page draws several of these (one per country), so their names differ. */
  dataLabel?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const skey = sortKey ?? segments[segments.length - 1]?.key ?? "";
  const segKeys = new Set(segments.map((s) => s.key));
  const total = (r: Row) => segments.reduce((s, seg) => s + num(r[seg.key]), 0);
  // Shares need a positive total; amounts are drawn whatever the total's sign (negative parts left of zero).
  const eligible = rows.filter((row) => finite(row[skey]) && (!normalizationKey || (finite(row[normalizationKey]) && (!normalize || num(row[normalizationKey]) > 0))) && segments.every((segment) => finite(row[segment.key])));
  const data = sortCompositionRows(eligible, skey, sortDirection);
  const domain = signedDomain(data.map((row) => segments.map((segment) => num(row[segment.key]))), normalize, normalizationKey ? data.map((row) => num(row[normalizationKey])) : undefined);
  const hasNegative = data.some((row) => segments.some((segment) => num(row[segment.key]) < 0));
  // Amounts carry their unit in the readout (shares already end in "%").
  const withUnit = (text: string, format?: string) => (format === "amount" ? `${text} 百万美元` : text);
  const tipLines = (r: Row): [string, string][] => [
    ["", rowLabel(r)],
    ...segments.map((s) => [s.name, withUnit(fmtVal(num(r[s.key]), valueFormat), valueFormat)] as [string, string]),
    // 排序指标若不在分段里(如按总出口/总量排序),额外单列,用它自己的格式
    ...(sortLabel && !segKeys.has(skey) ? [[sortLabel, withUnit(fmtVal(num(r[skey]), sortFormat), sortFormat)] as [string, string]] : []),
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 14 }}>
        <Legend items={[...segments.map((s, i) => ({ name: s.name, color: compositionSegmentColor(s, i, false) })), ...(hasNegative ? [NEGATIVE_COMPOSITION_STYLE] : [])]} />
      </div>
      {data.length === 0 ? <p className="muted" role="status">构成条当前没有可显示的有效数据。</p> : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.map((r) => {
          const entity = rowName(r);
          const display = rowLabel(r);
          const hi = highlight?.has(entity);
          const layout = signedStack(segments.map((segment) => num(r[segment.key])), domain, normalize, normalizationKey ? num(r[normalizationKey]) : undefined);
          return (
            <div key={entity} className="composition-chart-row"
              onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
              <span className="composition-chart-label" title={display} style={{ fontWeight: hi ? 700 : 500,
                color: hi ? "#4b47e0" : "#5a6070" }}>{display}</span>
              <div className="composition-chart-track" style={{ position: "relative", height: 17, background: "#f2f3f7", borderRadius: 5, overflow: "hidden" }}>
                {domain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 3, top: 0, bottom: 0, left: `${layout.zeroPct}%`, borderLeft: "1.5px solid #4b5263" }} />}
                {segments.map((s, i) => {
                  const segment = layout.segments[i];
                  return <span key={s.key} style={{
                    position: "absolute", top: 0, bottom: 0, left: `${segment.leftPct}%`,
                    width: `${segment.widthPct}%`, background: compositionSegmentColor(s, i, segment.negative),
                    borderRight: "2px solid #fff",
                  }} />;
                })}
              </div>
              <span className="composition-chart-value">
                {/* 归一化条右侧显示排序指标值(用其自身格式);绝对条显示分段总量(用分段格式) */}
                {normalize ? fmtVal(num(r[skey]), sortFormat ?? valueFormat) : fmtVal(total(r), valueFormat)}
              </span>
            </div>
          );
        })}
      </div>
      )}
      <ChartDataDisclosure
        label={`${dataLabel ? `${dataLabel} · ` : ""}${sortLabel ?? "分段"}构成`}
        columns={[
          { key: "entity", label: "对象" },
          ...segments.map((segment) => ({ key: segment.key, label: segment.name })),
          ...(sortLabel && !segKeys.has(skey) ? [{ key: "sort", label: sortLabel }] : []),
        ]}
        rows={data.map((row) => ({
          entity: rowLabel(row),
          ...Object.fromEntries(segments.map((segment) => [segment.key, fmtVal(num(row[segment.key]), valueFormat)])),
          ...(sortLabel && !segKeys.has(skey) ? { sort: fmtVal(num(row[skey]), sortFormat) } : {}),
        }))}
      />
      {Tip}
    </div>
  );
}
