import { ScrollableRegion } from "../../a11y";
import { niceDomain } from "../nice-ticks";
import { formatMetric, stripNegativeZero } from "../../format";
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
      <summary>查看{label}图表数据表</summary>
      {rows.length === 0 ? (
        <p className="muted" role="status">{label}当前没有可显示的有效数据。</p>
      ) : (
        <ScrollableRegion className="table-wrap chart-data-table-wrap" label={`${label}图表数据表，可横向滚动`}>
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
  if (format === "pct") return `${stripNegativeZero((v * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }))}%`;
  if (Math.abs(v) < 1e4) return stripNegativeZero(v.toLocaleString("zh-CN", { maximumFractionDigits: 3 }));
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

/** White-background selected-row text; 5.14:1 contrast at small text size. */
export const RANK_HIGHLIGHT_TEXT = "#c43d3d";

/** 任意指标的排序条形图(学生自选指标 + 对象后驱动) */
export function RankBarChart({ rows, metricKey, label, format, highlight }: {
  rows: Row[]; metricKey: string; label: string; format?: string; highlight?: Set<string>;
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
          // 极小值也保留 1% 可见宽度;负值向左扩,保持贴住零轴。
          const widthPct = Math.max(1, segment.widthPct);
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
                color: hi ? RANK_HIGHLIGHT_TEXT : "#5a6070", fontWeight: hi ? 700 : 400,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
              <div style={{ flex: 1, position: "relative", height: 16, background: "#f2f3f7", borderRadius: 5, overflow: "hidden" }}>
                {domain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 2, insetBlock: 0, left: `${layout.zeroPct}%`, borderLeft: "1.5px solid #4b5263" }} />}
                <div style={{
                  position: "absolute", top: 0, bottom: 0,
                  left: `${leftPct}%`, width: `${widthPct}%`,
                  background: segment.negative ? "#e34948" : hi ? CAT[5] : CAT[0],
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

type LabelBox = { x0: number; x1: number; y0: number; y1: number };
const boxesOverlap = (a: LabelBox, b: LabelBox) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Place point labels without collisions: highest priority first (selected, then key economies), trying
 * right, left, above and below the point; a label also avoids the highlighted dots. If nothing fits it
 * keeps the right-hand position, as before.
 */
export function placeScatterLabels(
  labels: { id: string; text: string; x: number; y: number; priority: number }[],
  avoid: { x: number; y: number }[],
  bounds: { left: number; right: number; top: number; bottom: number },
) {
  const placed: LabelBox[] = [];
  const dots = avoid.map((dot) => ({ x0: dot.x - 7, x1: dot.x + 7, y0: dot.y - 7, y1: dot.y + 7 }));
  return [...labels].sort((a, b) => b.priority - a.priority).map((label) => {
    const width = label.text.length * 6.2;
    const candidates = [
      { x: label.x + 7, y: label.y + 3.5, anchor: "start" as const, box: { x0: label.x + 7, x1: label.x + 7 + width, y0: label.y - 5, y1: label.y + 5 } },
      { x: label.x - 7, y: label.y + 3.5, anchor: "end" as const, box: { x0: label.x - 7 - width, x1: label.x - 7, y0: label.y - 5, y1: label.y + 5 } },
      { x: label.x, y: label.y - 9, anchor: "middle" as const, box: { x0: label.x - width / 2, x1: label.x + width / 2, y0: label.y - 18, y1: label.y - 8 } },
      { x: label.x, y: label.y + 17, anchor: "middle" as const, box: { x0: label.x - width / 2, x1: label.x + width / 2, y0: label.y + 8, y1: label.y + 18 } },
    ];
    const inside = (box: LabelBox) => box.x0 >= bounds.left && box.x1 <= bounds.right && box.y0 >= bounds.top && box.y1 <= bounds.bottom;
    const free = (box: LabelBox) => inside(box)
      && !placed.some((other) => boxesOverlap(box, other))
      && !dots.some((dot) => boxesOverlap(box, dot) && !(Math.abs((dot.x0 + dot.x1) / 2 - label.x) < 0.5 && Math.abs((dot.y0 + dot.y1) / 2 - label.y) < 0.5));
    const choice = candidates.find((candidate) => free(candidate.box)) ?? candidates[0];
    placed.push(choice.box);
    return { id: label.id, text: label.text, x: choice.x, y: choice.y, anchor: choice.anchor };
  });
}

/** 象限散点图:两条参考线(默认中位数)把平面切成四象限,四角标注角色。
 *  步6「定位图」(外国增加值项占比×跨境生产占比)等双指标比较。 */
/** A highlighted economy's path through the years on the scatter (phase 2 定位图 轨迹). */
export interface ScatterTrail { id: string; label: string; color: string; points: { year: number; x: number; y: number }[] }

export function QuadrantScatter({ rows, referenceRows, xKey, yKey, xLabel, yLabel, xFormat, yFormat, highlight, refMode = "median", quadrantLabels, equalityLine = false, xScale = "linear", trails = [] }: {
  rows: Row[]; xKey: string; yKey: string; xLabel: string; yLabel: string;
  referenceRows?: Row[];
  xFormat?: string; yFormat?: string; highlight?: Set<string>;
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
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>横轴 {xLabel} · 纵轴 {yLabel} <span style={{ fontSize: 10.5, color: "#5f6677", fontWeight: 400 }}>（参考线基于完整有效样本 n={referencePts.length}）</span></div>
      {pts.length === 0 ? <p className="muted" role="status">横轴 {xLabel} · 纵轴 {yLabel} 当前没有可显示的有效数据。</p> : (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        {yAxis.ticks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={m.l} y1={py(t)} x2={W - m.r} y2={py(t)} stroke="#eef0f5" strokeWidth={1} />
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#5f6677">{fmtAxis(t, yFormat)}</text>
          </g>
        ))}
        {xAxis.ticks.map((t, i) => (
          <text key={`x${i}`} x={log ? px(10 ** t) : px(t)} y={H - m.b + 18} textAnchor="middle" fontSize="10.5" fill="#5f6677">{fmtAxis(log ? 10 ** t : t, xFormat)}</text>
        ))}
        {/* 象限参考线(中位数) */}
        <line x1={px(xRef)} y1={m.t} x2={px(xRef)} y2={H - m.b} stroke="#c8ccd6" strokeWidth={1} strokeDasharray="4 4" />
        <line x1={m.l} y1={py(yRef)} x2={W - m.r} y2={py(yRef)} stroke="#c8ccd6" strokeWidth={1} strokeDasharray="4 4" />
        {equalityLine && !log && (() => {
          const lo = Math.max(x0, y0);
          const hi = Math.min(x1, y1);
          return lo < hi ? (
            <line x1={px(lo)} y1={py(lo)} x2={px(hi)} y2={py(hi)} stroke="#e0982a" strokeWidth={1.5} strokeDasharray="7 4">
              <title>PLv_GVC = PLy_GVC；线上方更偏上游，线下方更偏下游</title>
            </line>
          ) : null;
        })()}
        {/* 轴标题 */}
        <text x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle" fontSize="11.5" fill="#5a6070">{xLabel}</text>
        <text x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" fontSize="11.5" fill="#5a6070"
          transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{yLabel}</text>
        {/* Highlighted points are drawn last so ordinary points never cover them. */}
        {[...pts].sort((a, b) => Number(highlight?.has(a.c) ?? false) - Number(highlight?.has(b.c) ?? false)).map((p) => {
          const hi = highlight?.has(p.c);
          return (
            <g key={p.c}
              onMouseMove={(e) => show(e, [["", p.label], [xLabel, fmtVal(p.x, xFormat)], [yLabel, fmtVal(p.y, yFormat)]])}
              onMouseLeave={hide} style={{ cursor: "pointer" }}>
              <circle cx={px(p.x)} cy={py(p.y)} r={hi ? 6 : 4.5}
                fill={hi ? CAT[5] : CAT[0]} fillOpacity={hi ? 0.95 : 0.62} stroke="#fff" strokeWidth={1} />
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
                <g key={point.year} onMouseMove={(e) => show(e, [["", `${trail.label} · ${point.year}`], [xLabel, fmtVal(point.x, xFormat)], [yLabel, fmtVal(point.y, yFormat)]])} onMouseLeave={hide}>
                  <circle cx={px(point.x)} cy={py(point.y)} r={index === 0 || index === points.length - 1 ? 4 : 2.5} fill={index === 0 ? "#fff" : trail.color} stroke={trail.color} strokeWidth={1.5} />
                </g>
              ))}
              {/* No per-trail "2016→2020" text: placed outside the label layout it overlapped the country labels.
                  The note above the chart explains hollow start / solid end, and each point's tooltip names its year. */}
            </g>
          );
        })}
        {placeScatterLabels(
          pts.filter((p) => showLabels || highlight?.has(p.c) || KEY_ECONOMIES.has(p.tag))
            .map((p) => ({ id: p.c, text: p.tag, x: px(p.x), y: py(p.y), priority: highlight?.has(p.c) ? 2 : KEY_ECONOMIES.has(p.tag) ? 1 : 0 })),
          pts.filter((p) => highlight?.has(p.c)).map((p) => ({ x: px(p.x), y: py(p.y) })),
          { left: m.l, right: W - m.r, top: m.t, bottom: H - m.b },
        ).map((label) => {
          const hi = highlight?.has(label.id);
          const key = KEY_ECONOMIES.has(label.text);
          return (
            <text key={`label-${label.id}`} x={label.x} y={label.y} textAnchor={label.anchor} fontSize="10" pointerEvents="none"
              stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
              fill={hi ? RANK_HIGHLIGHT_TEXT : key ? "#3a4050" : "#5f6677"} fontWeight={hi || key ? 700 : 400}>{label.text}</text>
          );
        })}
        {/* 四角角色标签：画在点之上，白色描边保证可读 */}
        {quadrantLabels?.map((lab, i) => (
          <text key={i} x={corners[i].x} y={corners[i].y} textAnchor={corners[i].anchor} pointerEvents="none"
            stroke="#fff" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke"
            fontSize="10.5" fill="#5f6677" fontWeight={600}>{lab}</text>
        ))}
      </svg>
      )}
      {equalityLine && pts.length > 0 && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}><span style={{ color: "var(--text-warning)", fontWeight: 700 }}>橙色虚线 y=x</span>：线上方 PLv_GVC &gt; PLy_GVC（GVCPs &gt; 1，更偏上游）；线下方更偏下游。灰色中位数线只表示相对高低。</div>}
      <ChartDataDisclosure
        label={`${yLabel}与${xLabel}散点`}
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

export function CompositionBar({ rows, segments, sortKey, sortDirection = "descending", sortLabel, sortFormat, normalize = true, normalizationKey, valueFormat = "pct", highlight }: {
  rows: Row[]; segments: readonly CompositionSegment[]; sortKey?: string;
  sortDirection?: CompositionSortDirection; sortLabel?: string; sortFormat?: string;
  normalize?: boolean; normalizationKey?: string; valueFormat?: string; highlight?: Set<string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const skey = sortKey ?? segments[segments.length - 1]?.key ?? "";
  const segKeys = new Set(segments.map((s) => s.key));
  const total = (r: Row) => segments.reduce((s, seg) => s + num(r[seg.key]), 0);
  const eligible = rows.filter((row) => finite(row[skey]) && (!normalizationKey || (finite(row[normalizationKey]) && num(row[normalizationKey]) > 0)) && segments.every((segment) => finite(row[segment.key])));
  const data = sortCompositionRows(eligible, skey, sortDirection);
  const domain = signedDomain(data.map((row) => segments.map((segment) => num(row[segment.key]))), normalize, normalizationKey ? data.map((row) => num(row[normalizationKey])) : undefined);
  const hasNegative = data.some((row) => segments.some((segment) => num(row[segment.key]) < 0));
  const tipLines = (r: Row): [string, string][] => [
    ["", rowLabel(r)],
    ...segments.map((s) => [s.name, fmtVal(num(r[s.key]), valueFormat)] as [string, string]),
    // 排序指标若不在分段里(如按总出口/总量排序),额外单列,用它自己的格式
    ...(sortLabel && !segKeys.has(skey) ? [[sortLabel, fmtVal(num(r[skey]), sortFormat)] as [string, string]] : []),
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
        label={`${sortLabel ?? "分段"}构成`}
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
