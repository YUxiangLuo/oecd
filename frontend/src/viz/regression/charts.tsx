import { globalInferenceIsSuppressed, INTERVAL_FIRST_MENTION, signedEffect } from "../../regression-verdict";
import { CLUSTER_INTERVAL_LABEL, formatPValue } from "../../regression-statistics";
import type { DepvarKind, RegressionStatus, TreatmentSupport } from "../../types";
import { cardStyle, useTip } from "../shared";
import { niceDomain } from "../nice-ticks";

/** Approximate SVG text width (generous, so a clamped label never reaches a neighbour): CJK 1 em, Latin 0.62 em. */
export function svgTextWidth(text: string, size: number): number {
  return [...text].reduce((width, char) => width + (/[⺀-￿]/.test(char) ? size : size * 0.62), 0);
}

/** Centre of a centred label of the given width, kept inside [left, right]. */
function clampCentre(centre: number, width: number, left: number, right: number): number {
  return Math.min(Math.max(centre, left + width / 2), right - width / 2);
}

/** Signed, as the headline and the interval print it ("+0.008", "[-0.011, +0.026]"). */
const withSign = (value: number, text: string) => (value >= 0 && !text.startsWith("+") ? `+${text}` : text);

/** The kind a counted slope unit names ("个位置指数单位" → position), so the slope follows the headline's digits. */
const UNIT_KINDS: Record<string, DepvarKind> = {
  个百分点: "share", 个长度单位: "length", 个位置指数单位: "position", 个中心性原始单位: "network",
};

export function scaleForestCoefs<T extends { coef: number; ci_low: number | null; ci_high: number | null }>(
  coefs: T[],
  scale: number,
): T[] {
  if (scale === 1) return coefs;
  return coefs.map((item) => ({
    ...item,
    coef: item.coef * scale,
    ci_low: item.ci_low == null ? null : item.ci_low * scale,
    ci_high: item.ci_high == null ? null : item.ci_high * scale,
  }));
}

function splitCoefName(name: string): string[] {
  if (name.length <= 16) return [name];
  const mid = Math.ceil(name.length / 2);
  let breakAt = -1;
  for (let i = 1; i < name.length - 1; i++) {
    if ("_ ".includes(name[i]) && (breakAt === -1 || Math.abs(i - mid) < Math.abs(breakAt - mid))) breakAt = i;
  }
  const cut = breakAt === -1 ? mid : breakAt + 1;
  return [name.slice(0, cut), name.slice(cut)];
}

/** Symmetric "nice" axis around 0 so the zero line always sits in the middle. */
function niceSymmetricTicks(maxAbs: number): number[] {
  const raw = maxAbs / 2;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const count = Math.max(1, Math.ceil(maxAbs / step));
  return Array.from({ length: 2 * count + 1 }, (_, index) => (index - count) * step);
}

const ESTIMATE = "#2a2f3a";
const NEUTRAL = "#b6bac6";

/**
 * Coefficient plot in the usual dot-and-whisker form: a vertical zero line, one row per coefficient,
 * the point estimate as a dot and the 95% interval as a capped whisker with its ends labelled.
 * One colour; the sign is read from the position relative to zero.
 */
export function CoefForestChart({
  coefs, globalStatus, globalSupport, scale = 1, unit, labels, title = "系数图",
}: {
  coefs: { name: string; coef: number; ci_low: number | null; ci_high: number | null; p: number | null; stars: string }[];
  globalStatus?: RegressionStatus | null;
  globalSupport?: TreatmentSupport | null;
  scale?: number;
  unit?: string;
  labels?: Record<string, string>;
  title?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const inferenceAllowed = !globalInferenceIsSuppressed(globalStatus, globalSupport);
  const suppressionCopy = "这次的数据不够判断方向，所以只显示估计值，不显示 95% 区间。";
  const pts = scaleForestCoefs(coefs, scale).map((coefficient) => ({
    ...coefficient,
    displayName: labels?.[coefficient.name] ?? coefficient.name,
    p: inferenceAllowed ? coefficient.p : null,
    lo: inferenceAllowed ? coefficient.ci_low : null,
    hi: inferenceAllowed ? coefficient.ci_high : null,
  }));
  const hasCi = pts.some((point) => point.lo != null && point.hi != null);
  // padT leaves a band above the first row for "0 = 无关联", so an estimate near 0 never has its value on it.
  const rowH = 64, padT = 30, padB = 46, labelW = 150, padR = 28;
  const width = 640, height = padT + pts.length * rowH + padB;
  const plotW = width - labelW - padR;
  const maxAbs = Math.max(
    ...pts.map((point) => Math.max(Math.abs(point.lo ?? point.coef), Math.abs(point.hi ?? point.coef))),
    1e-6,
  ) * 1.08;
  const ticks = niceSymmetricTicks(maxAbs);
  const extent = ticks.at(-1)!;
  const x = (value: number) => labelW + ((value + extent) / (2 * extent)) * plotW;
  const y = (index: number) => padT + (index + 0.5) * rowH;
  const decimals = Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(extent / 2))));
  const format = (value: number) => (value === 0 ? "0" : value.toFixed(decimals));
  // Shares (scale 1) match the headline: 3 decimals from 0.005 to 0.1 ("+0.008"), 2 significant digits below.
  // Signed like the headline and the interval ("+0.56", "[-0.011, +0.026]").
  const valueLabel = (value: number) => {
    if (scale === 1 && value !== 0 && Math.abs(value) < 0.1) return withSign(value, Math.abs(value) >= 0.005 ? value.toFixed(3) : value.toPrecision(2));
    return withSign(value, value.toFixed(Math.max(2, decimals)));
  };
  // A centred label is kept inside the plot: never into the row-label column on the left or past the right edge.
  const inPlot = (centre: number, text: string, size: number) => clampCentre(centre, svgTextWidth(text, size) + 4, labelW, width - padR);
  const tip = (point: (typeof pts)[number]): [string, string][] => inferenceAllowed ? [
    ["", point.displayName],
    [unit ? `估计值（${unit}）` : "估计值", valueLabel(point.coef)],
    ["95% 区间", point.lo != null && point.hi != null ? `[${valueLabel(point.lo)}, ${valueLabel(point.hi)}]` : "没有区间"],
    ["p 值", formatPValue(point.p, "没有 p 值")],
  ] : [["", point.displayName], [unit ? `估计值（${unit}）` : "估计值", valueLabel(point.coef)], ["说明", suppressionCopy]];
  const description = hasCi
    ? `估计值图：估计值及${CLUSTER_INTERVAL_LABEL}`
    : inferenceAllowed ? "估计值图：这次没有 95% 区间" : "估计值图：数据不够判断方向，只显示估计值";
  return (
    <div ref={wrapRef} className="coef-plot" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}{unit ? `（${unit}）` : ""}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        {!inferenceAllowed
          ? suppressionCopy
          : `点 = 估计值${hasCi ? ` · 横线 = ${INTERVAL_FIRST_MENTION}` : ""} · 竖线 = 0（X 与 Y 没有关联）；区间包含 0 时方向不确定`}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{hasCi ? `${description}；完整数值见“详细数字”里的系数表` : description}</title>
        {ticks.map((value) => (
          <g key={value}>
            {value !== 0 && <line x1={x(value)} x2={x(value)} y1={padT} y2={height - padB} stroke="#eef0f4" strokeWidth={1} />}
            <text x={x(value)} y={height - padB + 16} textAnchor="middle" fontSize={11} fill="#5f6677">{format(value)}</text>
          </g>
        ))}
        <line x1={labelW} x2={width - padR} y1={height - padB} y2={height - padB} stroke="#d7dae2" strokeWidth={1} />
        {unit && <text x={labelW + plotW / 2} y={height - 8} textAnchor="middle" fontSize={11} fill="#5f6677">{unit}</text>}
        {pts.map((point, index) => {
          const parts = splitCoefName(point.displayName);
          const fill = !inferenceAllowed ? NEUTRAL : ESTIMATE;
          // The value sits just above the estimate, kept inside the plot so it never meets the row label or whisker.
          const labelAt = inPlot(x(point.coef), valueLabel(point.coef), 11.5);
          const hasInterval = point.lo != null && point.hi != null;
          // An interval narrower than the dot would hide under it: draw a hollow ring and say so in words.
          const narrow = hasInterval && x(point.hi!) - x(point.lo!) < 2 * 6.5;
          const narrowText = narrow ? `区间很窄 [${valueLabel(point.lo!)}, ${valueLabel(point.hi!)}]，在图上与点重合` : "";
          const shortText = hasInterval ? `[${valueLabel(point.lo!)}, ${valueLabel(point.hi!)}]` : "";
          return (
            <g key={point.name} onMouseEnter={(event) => show(event, tip(point))} onMouseMove={(event) => show(event, tip(point))} onMouseLeave={hide}>
              <text x={labelW - 12} y={y(index) - (parts.length > 1 ? 5 : 0)} dominantBaseline="middle" textAnchor="end" fontSize={11.5} fill="#3a4050">
                {parts.map((part, partIndex) => <tspan key={part} x={labelW - 12} dy={partIndex === 0 ? 0 : 13}>{part}</tspan>)}
              </text>
              {point.lo != null && point.hi != null && (
                <g className="coef-ci" stroke={fill} strokeWidth={1.8}>
                  <line x1={x(point.lo)} x2={x(point.hi)} y1={y(index)} y2={y(index)} />
                  <line x1={x(point.lo)} x2={x(point.lo)} y1={y(index) - 8} y2={y(index) + 8} />
                  <line x1={x(point.hi)} x2={x(point.hi)} y1={y(index) - 8} y2={y(index) + 8} />
                  {narrow
                    ? <text data-narrow-ci x={inPlot(x(point.coef), narrowText, 10.5)} y={y(index) + 24} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">{narrowText}</text>
                    : x(point.hi) - x(point.lo) < 64
                    ? <text x={inPlot((x(point.lo) + x(point.hi)) / 2, shortText, 10.5)} y={y(index) + 22} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">{shortText}</text>
                    : <>
                      <text x={inPlot(x(point.lo), valueLabel(point.lo), 10.5)} y={y(index) + 22} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">{valueLabel(point.lo)}</text>
                      <text x={inPlot(x(point.hi), valueLabel(point.hi), 10.5)} y={y(index) + 22} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">{valueLabel(point.hi)}</text>
                    </>}
                </g>
              )}
              {narrow
                ? <circle cx={x(point.coef)} cy={y(index)} r={5} fill="none" stroke={fill} strokeWidth={2} />
                : <circle cx={x(point.coef)} cy={y(index)} r={6.5} fill={fill} stroke="#fff" strokeWidth={2} />}
              <text x={labelAt} y={y(index) - 21} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#2a2f3a">
                {valueLabel(point.coef)}
              </text>
            </g>
          );
        })}
        <line x1={x(0)} x2={x(0)} y1={padT - 6} y2={height - padB} stroke="#1f2430" strokeWidth={1.8} />
        <text x={x(0) + 5} y={padT - 12} fontSize={10.5} fill="#5f6677">0 = 无关联</text>
      </svg>
      {Tip}
    </div>
  );
}

const BIN = "#216cc0";

/**
 * Binned scatter: the within-transformed regressor on x, the mean within-transformed outcome in each of
 * ~20 equal-count bins on y, and the fitted line through the origin with the estimated slope. This is
 * what the regression "sees" after the fixed effects are taken out.
 */
export function BinScatterChart({ bins, slope, slopeUnit, slopeWords, kind, xLabel, yLabel, xScale = 100, yScale = 1, title = "回归在量什么" }: {
  bins: { x: number; y: number; n: number }[];
  /** The estimate in display units: shown Y units per one percentage point of X (what the label prints). */
  slope: number;
  /** Counted unit of the slope's Y change ("个百分点", "个长度单位"), printed after the number. */
  slopeUnit?: string;
  /**
   * The words for a lower and a higher Y ("低"/"高", "短"/"长") when the direction is settled (the 95% interval
   * excludes 0): the label then reads "Y 平均低 0.55 个百分点". Without them it gives the signed gap ("相差").
   */
  slopeWords?: { lower: string; higher: string };
  /** How Y is read, so the slope has the headline's digits (position 4: "0.0008"); defaults to the kind slopeUnit names. */
  kind?: DepvarKind;
  xLabel: string;
  yLabel: string;
  /** Display scales: shares are stored as fractions and shown in percentage points. */
  xScale?: number;
  yScale?: number;
  title?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const pts = bins.map((bin) => ({ x: bin.x * xScale, y: bin.y * yScale, n: bin.n }));
  const W = 640, H = 300, m = { l: 64, r: 20, t: 18, b: 48 };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xAxis = niceDomain(Math.min(0, ...xs), Math.max(0, ...xs));
  const fitted = [xAxis.lo, xAxis.hi].map((value) => value * slope);
  const yAxis = niceDomain(Math.min(0, ...ys, ...fitted), Math.max(0, ...ys, ...fitted));
  const x = (value: number) => m.l + ((value - xAxis.lo) / (xAxis.hi - xAxis.lo || 1)) * (W - m.l - m.r);
  const y = (value: number) => H - m.b - ((value - yAxis.lo) / (yAxis.hi - yAxis.lo || 1)) * (H - m.t - m.b);
  const digits = (axis: { hi: number; lo: number }) => Math.max(0, Math.min(4, 2 - Math.floor(Math.log10(Math.max(axis.hi - axis.lo, 1e-9) / 4))));
  const fx = (value: number) => value.toFixed(digits(xAxis));
  const fy = (value: number) => value.toFixed(digits(yAxis));
  // Ticks are round values: trailing zeros trimmed ("-0.1", not "-0.1000").
  const tick = (value: number, axis: { hi: number; lo: number }) => {
    const text = String(Number(value.toFixed(digits(axis))));
    return text === "-0" ? "0" : text;
  };
  // The slope has the headline's digits for its kind ("+0.008" for a weak share, "+0.0008" for the position
  // index); without a known kind, 2 decimals from 0.1, 3 from 0.005 and 2 significant digits below.
  const slopeKind = kind ?? (slopeUnit ? UNIT_KINDS[slopeUnit] : undefined);
  const slopeText = slopeKind ? signedEffect(slope, slopeKind) : withSign(slope, Math.abs(slope) >= 100 ? slope.toFixed(0)
    : Math.abs(slope) >= 0.1 ? slope.toFixed(2) : Math.abs(slope) >= 0.005 ? slope.toFixed(3) : slope.toPrecision(2));
  // An association across records, as in the result headline: "X 每高 1 个百分点，Y 平均低 0.55 个百分点"; with
  // the direction open, the signed gap ("平均相差 +0.008").
  const slopeReading = slopeWords && slope !== 0
    ? `平均${slope < 0 ? slopeWords.lower : slopeWords.higher} ${slopeText.replace(/^[+-]/, "")}`
    : `平均相差 ${slopeText}`;
  // The label sits on the side of the dashed x = 0 line with more room, so it never crosses that line; when one
  // line of text does not fit there, it breaks after "，" into two.
  const zeroX = x(0), plotLeft = m.l + 6, plotRight = W - m.r - 6, gap = 8;
  const roomRight = plotRight - (zeroX + gap), roomLeft = zeroX - gap - plotLeft;
  const slopeLines = slopeUnit ? [`斜率：X 每高 1 个百分点，`, `Y ${slopeReading} ${slopeUnit}`] : [`斜率 = ${slopeText}`];
  const oneLine = slopeLines.join("");
  const fits = (lines: string[], room: number) => Math.max(...lines.map((line) => svgTextWidth(line, 11))) + 4 <= room;
  // Right-aligned at the right edge as before when it fits there; otherwise the left side; otherwise two lines.
  const onRight = fits([oneLine], roomRight) || (!fits([oneLine], roomLeft) && roomRight >= roomLeft);
  const labelLines = fits([oneLine], onRight ? roomRight : roomLeft) ? [oneLine] : slopeLines;
  const labelWidth = Math.max(...labelLines.map((line) => svgTextWidth(line, 11)));
  const labelX = onRight ? plotRight : plotLeft;
  const span = onRight ? [plotRight - labelWidth, plotRight] : [plotLeft, plotLeft + labelWidth];
  // Top or bottom corner, whichever is farther from the fitted line where the label runs, so it never sits on the line.
  const lineAt = (px: number) => y(fitted[0]) + ((px - x(xAxis.lo)) / (x(xAxis.hi) - x(xAxis.lo) || 1)) * (y(fitted[1]) - y(fitted[0]));
  const lineHeight = 13, blockHeight = (labelLines.length - 1) * lineHeight;
  const topFirst = m.t + 12, bottomFirst = H - m.b - 6 - blockHeight;
  const clearance = (first: number) => Math.min(...span.map((px) => {
    const lineY = lineAt(px);
    return lineY < first - 11 ? first - 11 - lineY : lineY > first + blockHeight ? lineY - first - blockHeight : 0;
  }));
  const slopeLabelY = clearance(topFirst) >= clearance(bottomFirst) ? topFirst : bottomFirst;
  const description = `分箱散点图：横轴为扣掉平均水平后的 X，纵轴为各组 Y 的平均；直线的斜率就是估计值`;
  return (
    <div ref={wrapRef} className="binscatter-plot" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        把全部记录按 X 从小到大最多分成 {bins.length} 组，每个点是一组的平均值；很多记录的 X 相同时，几组的点会重合，看到的点会少一些。X 和 Y 都先扣掉了每个国家×行业自己的平均水平和每年的共同变化。直线的斜率就是估计值。
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{description}</title>
        {yAxis.ticks.map((tick_) => (
          <g key={`y${tick_}`}>
            <line x1={m.l} x2={W - m.r} y1={y(tick_)} y2={y(tick_)} stroke={tick_ === 0 ? "#9aa3b5" : "#eef0f4"} strokeDasharray={tick_ === 0 ? "4 3" : undefined} />
            <text x={m.l - 8} y={y(tick_) + 4} textAnchor="end" fontSize={11} fill="#5f6677">{tick(tick_, yAxis)}</text>
          </g>
        ))}
        {xAxis.ticks.map((tick_) => (
          <g key={`x${tick_}`}>
            <line x1={x(tick_)} x2={x(tick_)} y1={m.t} y2={H - m.b} stroke={tick_ === 0 ? "#9aa3b5" : "#eef0f4"} strokeDasharray={tick_ === 0 ? "4 3" : undefined} />
            <text x={x(tick_)} y={H - m.b + 16} textAnchor="middle" fontSize={11} fill="#5f6677">{tick(tick_, xAxis)}</text>
          </g>
        ))}
        <text x={m.l + (W - m.l - m.r) / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="#5f6677">{xLabel}</text>
        <text x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" fontSize={11} fill="#5f6677" transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{yLabel}</text>
        <line data-fit x1={x(xAxis.lo)} y1={y(fitted[0])} x2={x(xAxis.hi)} y2={y(fitted[1])} stroke={ESTIMATE} strokeWidth={2.2} />
        {pts.map((point, index) => (
          <g key={index} data-bin={index}
            onMouseEnter={(event) => show(event, [["", `第 ${index + 1}/${pts.length} 箱 · ${point.n.toLocaleString("zh-CN")} 条记录`], [`X（${xLabel}）`, fx(point.x)], [`Y（${yLabel}）`, fy(point.y)]])}
            onMouseMove={(event) => show(event, [["", `第 ${index + 1}/${pts.length} 箱 · ${point.n.toLocaleString("zh-CN")} 条记录`], [`X（${xLabel}）`, fx(point.x)], [`Y（${yLabel}）`, fy(point.y)]])}
            onMouseLeave={hide}>
            <circle cx={x(point.x)} cy={y(point.y)} r={9} fill="transparent" />
            <circle cx={x(point.x)} cy={y(point.y)} r={5} fill={BIN} fillOpacity={0.9} stroke="#fff" strokeWidth={1.5} />
          </g>
        ))}
        {/* Kept inside the plot (a line ending at the bottom put it on the x tick labels); small slopes keep
            two significant figures so they match the coefficient chart (-0.0049, not -0.005). */}
        {/* A white halo keeps the label readable where the line still runs under it near a corner. */}
        <text data-slope-label x={labelX} y={slopeLabelY} textAnchor={onRight ? "end" : "start"} fontSize={11} fontWeight={700} fill={ESTIMATE} stroke="#fff" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
          {labelLines.length === 1
            ? labelLines[0]
            : labelLines.map((line, index) => <tspan key={line} x={labelX} dy={index ? lineHeight : 0}>{line}</tspan>)}
        </text>
      </svg>
      {Tip}
    </div>
  );
}

const TAXED = "#d6731f";
const UNTAXED = "#6b7487";

/**
 * Two lines: taxed vs untaxed countries, each group's mean Y minus its own pre-policy mean.
 * A dashed line marks when the simulated tariff starts; the gap that opens after it is what the
 * regression then quantifies.
 */
/** Centres for stacked labels: in order of their wanted position, at least half of both heights apart, inside [top, bottom]. */
export function spreadLabels(items: { key: string; at: number; size: number }[], top: number, bottom: number): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const centres = sorted.map((item) => item.at);
  const gap = (index: number) => (sorted[index - 1].size + sorted[index].size) / 2 + 2;
  for (let index = 1; index < sorted.length; index++) centres[index] = Math.max(centres[index], centres[index - 1] + gap(index));
  const last = sorted.length - 1;
  if (last >= 0) centres[last] = Math.min(centres[last], bottom - sorted[last].size / 2);
  for (let index = last - 1; index >= 0; index--) centres[index] = Math.min(centres[index], centres[index + 1] - gap(index + 1));
  if (sorted.length) centres[0] = Math.max(centres[0], top + sorted[0].size / 2);
  for (let index = 1; index < sorted.length; index++) centres[index] = Math.max(centres[index], centres[index - 1] + gap(index));
  return Object.fromEntries(sorted.map((item, index) => [item.key, centres[index]]));
}

export function GroupChangeChart({
  years, policyYear, taxed, untaxed, scale = 1, unit, title, estimate,
}: {
  years: number[];
  policyYear: number;
  taxed: { year: number; change: number }[];
  untaxed: { year: number; change: number }[];
  /** Multiplier from stored Y units to displayed units (e.g. 100 for shares shown in percentage points). */
  scale?: number;
  unit: string;
  title: string;
  /** After the run: the gap the estimate implies (β × mean exposure), in stored Y units, drawn at the last year. */
  estimate?: {
    gap: number;
    label: string;
    /** The 95% interval includes 0: a third line says "（方向不确定）", as the reading card below does. */
    uncertain?: boolean;
  } | null;
}) {
  const width = 640, height = 250, padL = 64, padR = 140, padT = 22, padB = 34;
  const values = [...taxed, ...untaxed].map((point) => point.change * scale);
  const estimateEnd = estimate ? (untaxed.at(-1)?.change ?? 0) + estimate.gap : null;
  if (estimateEnd != null) values.push(estimateEnd * scale);
  const maxAbs = Math.max(...values.map(Math.abs), 1e-9) * 1.1;
  const ticks = niceSymmetricTicks(maxAbs);
  const extent = ticks.at(-1)!;
  const decimals = Math.max(0, Math.min(4, 1 - Math.floor(Math.log10(extent / 2))));
  const x = (year: number) => padL + ((year - years[0]) / Math.max(1, years.at(-1)! - years[0])) * (width - padL - padR);
  const y = (value: number) => padT + ((extent - value) / (2 * extent)) * (height - padT - padB);
  const path = (series: { year: number; change: number }[]) => series
    .map((point, index) => `${index ? "L" : "M"}${x(point.year)},${y(point.change * scale)}`).join(" ");
  const policyX = (x(policyYear - 1) + x(policyYear)) / 2;
  const lastTaxed = taxed.at(-1)?.change ?? 0, lastUntaxed = untaxed.at(-1)?.change ?? 0;
  // The two group names and the two-line estimate share the right margin. When the lines end close together
  // (a weak Y) they would print on top of each other, so their centres are pushed apart, keeping their order.
  const estimateY = estimate && estimateEnd != null ? (y(lastUntaxed * scale) + y(estimateEnd * scale)) / 2 : null;
  const slots = spreadLabels([
    { key: "taxed", at: y(lastTaxed * scale) + (lastTaxed < lastUntaxed ? 8 : -8), size: 14 },
    { key: "untaxed", at: y(lastUntaxed * scale) + (lastTaxed < lastUntaxed ? -8 : 8), size: 14 },
    ...(estimateY == null ? [] : [{ key: "estimate", at: estimateY, size: estimate?.uncertain ? 42 : 28 }]),
  ], padT, height - 4);
  const label = (series: { year: number; change: number }[], text: string, color: string, key: string) => {
    const last = series.at(-1);
    return last && <text x={x(last.year) + 8} y={slots[key]} dominantBaseline="middle" fontSize={11.5} fontWeight={700} fill={color}>{text}</text>;
  };
  const [estimateHead, ...estimateRest] = (estimate?.label ?? "").split(" ");
  const estimateValue = estimateRest.join(" ");
  const description = `${title}：加税组与未加税组相对加税前平均水平的变化，${policyYear} 年起加税`;
  return (
    <div className="group-change-chart" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        纵轴：相对 {years[0]}–{policyYear - 1} 年平均水平的变化（{unit}）
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{description}</title>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={padL} x2={width - padR} y1={y(value)} y2={y(value)} stroke={value === 0 ? "#9aa0ad" : "#eef0f4"} strokeWidth={1} />
            <text x={padL - 8} y={y(value)} dominantBaseline="middle" textAnchor="end" fontSize={11} fill="#5f6677">{value === 0 ? "0" : value.toFixed(decimals)}</text>
          </g>
        ))}
        {years.map((year) => <text key={year} x={x(year)} y={height - 12} textAnchor="middle" fontSize={11} fill="#5f6677">{year}</text>)}
        {estimate && estimateEnd != null && (() => {
          const lastYear = years.at(-1)!;
          const bx = x(lastYear) + 3;
          const y0 = y((untaxed.at(-1)?.change ?? 0) * scale), y1 = y(estimateEnd * scale);
          return (
            <g data-estimate stroke="#2a2f3a" strokeWidth={1.6}>
              <line x1={bx} x2={bx} y1={y0} y2={y1} strokeDasharray="3 3" />
              <line x1={bx - 4} x2={bx + 4} y1={y0} y2={y0} />
              <line x1={bx - 4} x2={bx + 4} y1={y1} y2={y1} />
              {/* Two lines ("回归估计的差距" / value and unit): on one line a unit such as 中心性原始单位 ran off the chart. */}
              <text x={bx + 7} y={slots.estimate + 4} fontSize={10.5} fill="#2a2f3a" stroke="none">
                <tspan x={bx + 7} dy={estimate.uncertain ? "-1.2em" : "-0.6em"}>{estimateHead}</tspan>
                <tspan x={bx + 7} dy="1.2em">{estimateValue}</tspan>
                {estimate.uncertain && <tspan data-estimate-uncertain x={bx + 7} dy="1.2em">（方向不确定）</tspan>}
              </text>
            </g>
          );
        })()}
        <line x1={policyX} x2={policyX} y1={padT - 8} y2={height - padB} stroke="#3a4050" strokeWidth={1.2} strokeDasharray="4 4" />
        <text x={policyX + 6} y={padT - 6} fontSize={11} fill="#3a4050">{policyYear} 年起加税</text>
        {([[untaxed, UNTAXED], [taxed, TAXED]] as const).map(([series, color]) => (
          <g key={color}>
            <path d={path(series)} fill="none" stroke={color} strokeWidth={2.4} />
            {series.map((point) => (
              <circle key={point.year} cx={x(point.year)} cy={y(point.change * scale)} r={3.5} fill={color}>
                <title>{`${point.year} 年：${(point.change * scale).toFixed(decimals + 1)} ${unit}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {label(taxed, "加税国家组", TAXED, "taxed")}
        {label(untaxed, "未加税国家组", UNTAXED, "untaxed")}
      </svg>
    </div>
  );
}
