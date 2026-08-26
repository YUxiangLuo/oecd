import { ScrollableRegion } from "../../a11y";
import { formatMetric } from "../../format";
import { CAT, KEY_ECONOMIES, Legend, type Row, cardStyle, num, rowLabel, rowName, useTip } from "../shared";
import { signedDomain, signedStack } from "../signed-layout";

/* ---------------- 步骤7-10 自由探索:排序条形图 / 散点图 ---------------- */

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
  if (format === "pct" || Math.abs(v) < 1e4) return fmtVal(v, format);
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
                color: hi ? CAT[5] : "#5a6070", fontWeight: hi ? 700 : 400,
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

/** 象限散点图:两条参考线(默认中位数)把平面切成四象限,四角标注角色。
 *  步8「GVC 定位图」(后向依赖×WWYZ 前向生产参与)、步11「枢纽地图」(度×介数中心性)。 */
export function QuadrantScatter({ rows, referenceRows, xKey, yKey, xLabel, yLabel, xFormat, yFormat, highlight, refMode = "median", quadrantLabels, equalityLine = false }: {
  rows: Row[]; xKey: string; yKey: string; xLabel: string; yLabel: string;
  referenceRows?: Row[];
  xFormat?: string; yFormat?: string; highlight?: Set<string>;
  refMode?: "median" | "mean"; quadrantLabels?: [string, string, string, string];
  /** Draw y=x when both axes share a unit (e.g. forward vs backward length). */
  equalityLine?: boolean;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const W = 660, H = 400, m = { l: 62, r: 18, t: 14, b: 46 };
  const pts = rows.filter((row) => finite(row[xKey]) && finite(row[yKey])).map((r) => ({
    c: rowName(r), label: rowLabel(r), tag: r.industry != null ? String(r.industry) : String(r.country),
    x: num(r[xKey]), y: num(r[yKey]),
  }));
  const requestedReferencePts = (referenceRows ?? rows)
    .filter((row) => finite(row[xKey]) && finite(row[yKey]))
    .map((r) => ({ x: num(r[xKey]), y: num(r[yKey]) }));
  const referencePts = requestedReferencePts.length ? requestedReferencePts : pts;
  const xs = referencePts.map((p) => p.x), ys = referencePts.map((p) => p.y);
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const [x0, x1] = spreadDomain(xs), [y0, y1] = spreadDomain(ys);
  const px = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const py = (y: number) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const ticks = (lo: number, hi: number) => [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) / 4) * i);
  const xRef = refMode === "mean" ? avg(xs) : median(xs);
  const yRef = refMode === "mean" ? avg(ys) : median(ys);
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
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{yLabel} × {xLabel} <span style={{ fontSize: 10.5, color: "#5f6677", fontWeight: 400 }}>（参考线基于完整有效样本 n={referencePts.length}）</span></div>
      {pts.length === 0 ? <p className="muted" role="status">{yLabel} × {xLabel} 当前没有可显示的有效数据。</p> : (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        {ticks(y0, y1).map((t, i) => (
          <g key={`y${i}`}>
            <line x1={m.l} y1={py(t)} x2={W - m.r} y2={py(t)} stroke="#eef0f5" strokeWidth={1} />
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#5f6677">{fmtAxis(t, yFormat)}</text>
          </g>
        ))}
        {ticks(x0, x1).map((t, i) => (
          <text key={`x${i}`} x={px(t)} y={H - m.b + 18} textAnchor="middle" fontSize="10.5" fill="#5f6677">{fmtAxis(t, xFormat)}</text>
        ))}
        {/* 象限参考线(中位数) */}
        <line x1={px(xRef)} y1={m.t} x2={px(xRef)} y2={H - m.b} stroke="#c8ccd6" strokeWidth={1} strokeDasharray="4 4" />
        <line x1={m.l} y1={py(yRef)} x2={W - m.r} y2={py(yRef)} stroke="#c8ccd6" strokeWidth={1} strokeDasharray="4 4" />
        {equalityLine && (() => {
          const lo = Math.max(x0, y0);
          const hi = Math.min(x1, y1);
          return lo < hi ? (
            <line x1={px(lo)} y1={py(lo)} x2={px(hi)} y2={py(hi)} stroke="#e0982a" strokeWidth={1.5} strokeDasharray="7 4">
              <title>PLv_GVC = PLy_GVC；线上方更偏上游，线下方更偏下游</title>
            </line>
          ) : null;
        })()}
        {/* 四角角色标签 */}
        {quadrantLabels?.map((lab, i) => (
          <text key={i} x={corners[i].x} y={corners[i].y} textAnchor={corners[i].anchor}
            fontSize="10.5" fill="#5f6677" fontWeight={600}>{lab}</text>
        ))}
        {/* 轴标题 */}
        <text x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle" fontSize="11.5" fill="#5a6070">{xLabel}</text>
        <text x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" fontSize="11.5" fill="#5a6070"
          transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{yLabel}</text>
        {pts.map((p) => {
          const hi = highlight?.has(p.c);
          const key = KEY_ECONOMIES.has(p.tag);
          return (
            <g key={p.c}
              onMouseMove={(e) => show(e, [["", p.label], [xLabel, fmtVal(p.x, xFormat)], [yLabel, fmtVal(p.y, yFormat)]])}
              onMouseLeave={hide} style={{ cursor: "pointer" }}>
              <circle cx={px(p.x)} cy={py(p.y)} r={hi ? 6 : 4.5}
                fill={hi ? CAT[5] : CAT[0]} fillOpacity={hi ? 0.95 : 0.62} stroke="#fff" strokeWidth={1} />
              {(showLabels || hi || key) && (
                <text x={px(p.x) + 7} y={py(p.y) + 3.5} fontSize="10" fill={hi ? CAT[5] : key ? "#3a4050" : "#5f6677"}
                  fontWeight={hi || key ? 700 : 400}>{p.tag}</text>
              )}
            </g>
          );
        })}
      </svg>
      )}
      {equalityLine && pts.length > 0 && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}><span style={{ color: "#e0982a", fontWeight: 700 }}>橙色虚线 y=x</span>：线上方 PLv_GVC &gt; PLy_GVC（GVCPs &gt; 1，更偏上游）；线下方更偏下游。灰色中位数线只表示相对高低。</div>}
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

export type CompositionSortDirection = "ascending" | "descending";

export function sortCompositionRows(
  rows: readonly Row[],
  sortKey: string,
  direction: CompositionSortDirection = "descending",
): Row[] {
  const sign = direction === "descending" ? -1 : 1;
  return [...rows].sort((first, second) => sign * (num(first[sortKey]) - num(second[sortKey])));
}

export function CompositionBar({ rows, segments, sortKey, sortDirection = "descending", sortLabel, sortFormat, normalize = true, valueFormat = "pct", highlight }: {
  rows: Row[]; segments: readonly CompositionSegment[]; sortKey?: string;
  sortDirection?: CompositionSortDirection; sortLabel?: string; sortFormat?: string;
  normalize?: boolean; valueFormat?: string; highlight?: Set<string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const skey = sortKey ?? segments[segments.length - 1]?.key ?? "";
  const segKeys = new Set(segments.map((s) => s.key));
  const total = (r: Row) => segments.reduce((s, seg) => s + num(r[seg.key]), 0);
  const eligible = rows.filter((row) => finite(row[skey]) && segments.every((segment) => finite(row[segment.key])));
  const data = sortCompositionRows(eligible, skey, sortDirection);
  const domain = signedDomain(data.map((row) => segments.map((segment) => num(row[segment.key]))), normalize);
  const hasNegative = data.some((row) => segments.some((segment) => num(row[segment.key]) < 0));
  const tipLines = (r: Row): [string, string][] => [
    ["", rowLabel(r)],
    ...segments.map((s) => [s.name, fmtVal(num(r[s.key]), valueFormat)] as [string, string]),
    // 排序指标若不在分段里(如按毛出口/总量排序),额外单列,用它自己的格式
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
          const layout = signedStack(segments.map((segment) => num(r[segment.key])), domain, normalize);
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
        label={`${sortLabel ?? "分段"} 构成`}
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
