import { formatMetric } from "../../format";
import { CAT, KEY_ECONOMIES, Legend, type Row, cardStyle, num, rowLabel, rowName, useTip } from "../shared";
import { signedDomain, signedStack } from "../signed-layout";
import { linearFit } from "../statistics";

/* ---------------- 步骤7-10 自由探索:排序条形图 / 散点图 ---------------- */

function fmtVal(v: number, format?: string): string {
  return formatMetric(v, format);
}

/** 轴刻度专用:大数用「万/亿」缩写,避免出现 4,857,813 这类挤满轴的原始值 */
function fmtAxis(v: number, format?: string): string {
  if (format === "pct" || Math.abs(v) < 1e4) return fmtVal(v, format);
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}亿`;
  return `${(v / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}万`;
}

/** 轴范围:两端各留 6% 呼吸;全非负数据不让下界跌破 0(避免画出并不存在的负区间) */
function spreadDomain(arr: number[]): readonly [number, number] {
  const lo = Math.min(...arr), hi = Math.max(...arr);
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1;
  return [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad] as const;
}

/** 任意指标的排序条形图(学生自选指标 + 对象后驱动) */
export function RankBarChart({ rows, metricKey, label, format, highlight }: {
  rows: Row[]; metricKey: string; label: string; format?: string; highlight?: Set<string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const data = [...rows].sort((a, b) => num(b[metricKey]) - num(a[metricKey]));
  const domain = signedDomain(data.map((row) => [num(row[metricKey])]), false);
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>{label} · 排序</div>
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
            <div key={entity} style={{ display: "flex", alignItems: "center", gap: 10 }}
              onMouseMove={(e) => show(e, [["", display], [label, fmtVal(v, format)]])}
              onMouseLeave={hide}>
              <span title={display} style={{ width: 132, flexShrink: 0, fontSize: 11.5, color: "#5a6070", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
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
      {Tip}
    </div>
  );
}

/** X × Y 两指标散点图(学生自选,用于看指标间关系) */
export function ScatterChart({ rows, xKey, yKey, xLabel, yLabel, xFormat, yFormat, highlight }: {
  rows: Row[]; xKey: string; yKey: string; xLabel: string; yLabel: string;
  xFormat?: string; yFormat?: string; highlight?: Set<string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const W = 660, H = 400, m = { l: 62, r: 18, t: 14, b: 46 };
  // c = 完整名(tooltip / 高亮匹配),tag = 图上短标签(行业只标代码,避免中文名越界)
  const pts = rows.map((r) => ({
    c: rowName(r), label: rowLabel(r), tag: r.industry != null ? String(r.industry) : String(r.country),
    x: num(r[xKey]), y: num(r[yKey]),
  }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const fit = linearFit(pts);
  const [x0, x1] = spreadDomain(xs), [y0, y1] = spreadDomain(ys);
  const px = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const py = (y: number) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const ticks = (lo: number, hi: number) => [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) / 4) * i);
  const showLabels = pts.length <= 24;
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{yLabel} × {xLabel}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        {/* 网格 + 刻度 */}
        {ticks(y0, y1).map((t, i) => (
          <g key={`y${i}`}>
            <line x1={m.l} y1={py(t)} x2={W - m.r} y2={py(t)} stroke="#eef0f5" strokeWidth={1} />
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#8a90a0">{fmtAxis(t, yFormat)}</text>
          </g>
        ))}
        {ticks(x0, x1).map((t, i) => (
          <text key={`x${i}`} x={px(t)} y={H - m.b + 18} textAnchor="middle" fontSize="10.5" fill="#8a90a0">{fmtAxis(t, xFormat)}</text>
        ))}
        {/* 轴标题 */}
        <text x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle" fontSize="11.5" fill="#5a6070">{xLabel}</text>
        <text x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" fontSize="11.5" fill="#5a6070"
          transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{yLabel}</text>
        {/* 前端 OLS 只用于描述相关形态，不代表因果识别。 */}
        {fit.slope != null && fit.intercept != null && (
          <line
            x1={px(Math.min(...xs))}
            y1={py(fit.intercept + fit.slope * Math.min(...xs))}
            x2={px(Math.max(...xs))}
            y2={py(fit.intercept + fit.slope * Math.max(...xs))}
            stroke="#e34948" strokeWidth={2} strokeDasharray="6 4"
          />
        )}
        {/* 点 */}
        {pts.map((p) => {
          const hi = highlight?.has(p.c);
          const key = KEY_ECONOMIES.has(p.tag);
          return (
            <g key={p.c}
              onMouseMove={(e) => show(e, [["", p.label], [xLabel, fmtVal(p.x, xFormat)], [yLabel, fmtVal(p.y, yFormat)]])}
              onMouseLeave={hide} style={{ cursor: "pointer" }}>
              <circle cx={px(p.x)} cy={py(p.y)} r={hi ? 6 : 4.5}
                fill={hi ? CAT[5] : CAT[0]} fillOpacity={hi ? 0.95 : 0.62}
                stroke="#fff" strokeWidth={1} />
              {(showLabels || hi || key) && (
                <text x={px(p.x) + 7} y={py(p.y) + 3.5} fontSize="10" fill={hi ? CAT[5] : key ? "#3a4050" : "#8a90a0"}
                  fontWeight={hi || key ? 700 : 400}>{p.tag}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, color: "#6f7686", marginTop: 4 }}>
        <b style={{ color: "#3a4050" }}>Pearson r = {fit.correlation == null ? "—" : fit.correlation.toFixed(3)}</b>
        <span>n = {fit.n}</span>
        <span style={{ color: "#e34948" }}>{fit.slope == null ? "X 轴无变异，无法拟合" : "虚线 = OLS 拟合"}</span>
        <span>相关不等于因果：共同趋势、遗漏变量与反向因果都可能产生斜率。</span>
      </div>
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
 *  步8「GVC 定位图」(后向×前向参与度)、步11「枢纽地图」(度×介数中心性)。 */
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
  const pts = rows.map((r) => ({
    c: rowName(r), label: rowLabel(r), tag: r.industry != null ? String(r.industry) : String(r.country),
    x: num(r[xKey]), y: num(r[yKey]),
  }));
  const referencePts = (referenceRows ?? rows).map((r) => ({ x: num(r[xKey]), y: num(r[yKey]) }));
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
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{yLabel} × {xLabel} <span style={{ fontSize: 10.5, color: "#8a90a0", fontWeight: 400 }}>（参考线基于完整有效样本 n={referencePts.length}）</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        {ticks(y0, y1).map((t, i) => (
          <g key={`y${i}`}>
            <line x1={m.l} y1={py(t)} x2={W - m.r} y2={py(t)} stroke="#eef0f5" strokeWidth={1} />
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#8a90a0">{fmtAxis(t, yFormat)}</text>
          </g>
        ))}
        {ticks(x0, x1).map((t, i) => (
          <text key={`x${i}`} x={px(t)} y={H - m.b + 18} textAnchor="middle" fontSize="10.5" fill="#8a90a0">{fmtAxis(t, xFormat)}</text>
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
            fontSize="10.5" fill="#9aa0ae" fontWeight={600}>{lab}</text>
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
                <text x={px(p.x) + 7} y={py(p.y) + 3.5} fontSize="10" fill={hi ? CAT[5] : key ? "#3a4050" : "#8a90a0"}
                  fontWeight={hi || key ? 700 : 400}>{p.tag}</text>
              )}
            </g>
          );
        })}
      </svg>
      {equalityLine && <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}><span style={{ color: "#e0982a", fontWeight: 700 }}>橙色虚线 y=x</span>：线上方 PLv_GVC &gt; PLy_GVC（GVCPs &gt; 1，更偏上游）；线下方更偏下游。灰色中位数线只表示相对高低。</div>}
      {Tip}
    </div>
  );
}

/** 构成条:指标驱动、可排序的横向堆叠条(步9 生产构成 / 步10 长度共用)。
 *  normalize=true 每条=分段和的 100%(步8 出口来源、步9 生产构成);
 *  normalize=false 用全局最大值的绝对宽度(步10 生产链长度)。 */
export function CompositionBar({ rows, segments, sortKey, sortLabel, sortFormat, normalize = true, valueFormat = "pct", highlight }: {
  rows: Row[]; segments: { key: string; name: string }[]; sortKey?: string;
  sortLabel?: string; sortFormat?: string;
  normalize?: boolean; valueFormat?: string; highlight?: Set<string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const skey = sortKey ?? segments[segments.length - 1]?.key ?? "";
  const segKeys = new Set(segments.map((s) => s.key));
  const total = (r: Row) => segments.reduce((s, seg) => s + num(r[seg.key]), 0);
  const data = [...rows].sort((a, b) => num(b[skey]) - num(a[skey]));
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
        <Legend items={[...segments.map((s, i) => ({ name: s.name, color: CAT[i] })), ...(hasNegative ? [{ name: "负分项（零轴左侧）", color: "#e34948" }] : [])]} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.map((r) => {
          const entity = rowName(r);
          const display = rowLabel(r);
          const hi = highlight?.has(entity);
          const layout = signedStack(segments.map((segment) => num(r[segment.key])), domain, normalize);
          return (
            <div key={entity} style={{ display: "flex", alignItems: "center", gap: 10 }}
              onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
              <span title={display} style={{ width: 128, flexShrink: 0, fontSize: 11.5, fontWeight: hi ? 700 : 500,
                color: hi ? "#4b47e0" : "#5a6070", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
              <div style={{ flex: 1, position: "relative", height: 17, background: "#f2f3f7", borderRadius: 5, overflow: "hidden" }}>
                {domain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 3, top: 0, bottom: 0, left: `${layout.zeroPct}%`, borderLeft: "1.5px solid #4b5263" }} />}
                {segments.map((s, i) => {
                  const segment = layout.segments[i];
                  return <span key={s.key} style={{
                    position: "absolute", top: 0, bottom: 0, left: `${segment.leftPct}%`,
                    width: `${segment.widthPct}%`, background: segment.negative ? "#e34948" : CAT[i],
                    borderRight: "2px solid #fff",
                  }} />;
                })}
              </div>
              <span style={{ width: 72, textAlign: "right", fontSize: 11.5, color: "#3a4050", fontVariantNumeric: "tabular-nums" }}>
                {/* 归一化条右侧显示排序指标值(用其自身格式);绝对条显示分段总量(用分段格式) */}
                {normalize ? fmtVal(num(r[skey]), sortFormat ?? valueFormat) : fmtVal(total(r), valueFormat)}
              </span>
            </div>
          );
        })}
      </div>
      {Tip}
    </div>
  );
}

/** 多国某指标的时间趋势折线图(学生自选指标 + 国家) */
export function TrendChart({ years, series, label, format }: {
  years: number[];
  series: { country: string; values: number[] }[];
  label: string; format?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  // 右边距按最长线尾标签自适应:行业下钻的中文名远比 3 字母国家码宽
  const maxLabelLen = Math.max(3, ...series.map((s) => s.country.length));
  const W = 660, H = 380, m = { l: 62, r: Math.min(190, Math.max(92, 14 + maxLabelLen * 10.5)), t: 16, b: 38 };
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const px = (i: number) => m.l + (years.length === 1 ? 0.5 : i / (years.length - 1)) * (W - m.l - m.r);
  const py = (v: number) => H - m.b - ((v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const yticks = [0, 1, 2, 3, 4].map((i) => y0 + ((y1 - y0) / 4) * i);
  // 线尾标签防碰撞:按终点纵坐标排序后保证至少 13px 间距,终值接近的系列不再叠字
  const labelYBySeries: Record<number, number> = {};
  series
    .map((s, si) => {
      const finite = s.values.map((v, i) => ({ i, v })).filter((p) => Number.isFinite(p.v));
      const last = finite.at(-1);
      return last ? { si, y: py(last.v) } : null;
    })
    .filter((e): e is { si: number; y: number } => e != null)
    .sort((a, b) => a.y - b.y)
    .reduce((prevY, e) => {
      const y = Math.min(H - 6, Math.max(e.y, prevY + 13));
      labelYBySeries[e.si] = y;
      return y;
    }, -Infinity);
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{label} · 趋势 {years[0]}–{years.at(-1)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%">
        {yticks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={m.l} y1={py(t)} x2={W - m.r} y2={py(t)} stroke="#eef0f5" strokeWidth={1} />
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#8a90a0">{fmtVal(t, format)}</text>
          </g>
        ))}
        {years.map((y, i) => (
          <text key={y} x={px(i)} y={H - m.b + 18} textAnchor="middle" fontSize="10.5" fill="#8a90a0">{y}</text>
        ))}
        {series.map((s, si) => {
          const color = CAT[si % CAT.length];
          const pts = s.values.map((v, i) => ({ i, v })).filter((p) => Number.isFinite(p.v));
          const d = pts.map((p, k) => `${k === 0 ? "M" : "L"}${px(p.i)},${py(p.v)}`).join(" ");
          const last = pts.at(-1);
          return (
            <g key={s.country}>
              <path d={d} fill="none" stroke={color} strokeWidth={2.2} />
              {pts.map((p) => (
                <circle key={p.i} cx={px(p.i)} cy={py(p.v)} r={3.5} fill={color} stroke="#fff" strokeWidth={1}
                  onMouseMove={(e) => show(e, [["", s.country], ["年份", String(years[p.i])], [label, fmtVal(p.v, format)]])}
                  onMouseLeave={hide} style={{ cursor: "pointer" }} />
              ))}
              {last && (
                <text x={px(last.i) + 7} y={(labelYBySeries[si] ?? py(last.v)) + 3.5} fontSize="10.5" fill={color} fontWeight={700}>{s.country}</text>
              )}
            </g>
          );
        })}
      </svg>
      {Tip}
    </div>
  );
}
