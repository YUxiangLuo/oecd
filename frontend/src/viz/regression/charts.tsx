import { globalInferenceIsSuppressed } from "../../regression-verdict";
import { CLUSTER_INTERVAL_LABEL, formatPValue } from "../../regression-statistics";
import type { RegressionStatus, TreatmentSupport } from "../../types";
import { cardStyle, useTip } from "../shared";
import { niceDomain } from "../nice-ticks";

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
  const suppressionCopy = "整体设计门禁已抑制统计推断；仅显示描述性点估计。";
  const pts = scaleForestCoefs(coefs, scale).map((coefficient) => ({
    ...coefficient,
    displayName: labels?.[coefficient.name] ?? coefficient.name,
    p: inferenceAllowed ? coefficient.p : null,
    lo: inferenceAllowed ? coefficient.ci_low : null,
    hi: inferenceAllowed ? coefficient.ci_high : null,
  }));
  const hasCi = pts.some((point) => point.lo != null && point.hi != null);
  const rowH = 64, padT = 16, padB = 46, labelW = 150, padR = 28;
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
  const valueLabel = (value: number) => (Math.abs(value) < 0.01 && scale === 1 ? value.toFixed(4) : value.toFixed(Math.max(2, decimals)));
  const tip = (point: (typeof pts)[number]): [string, string][] => inferenceAllowed ? [
    ["", point.displayName],
    ["系数", valueLabel(point.coef)],
    ["标称 95% CI", point.lo != null && point.hi != null ? `[${valueLabel(point.lo)}, ${valueLabel(point.hi)}]` : "不可评估"],
    ["p 值", formatPValue(point.p, "不可评估")],
  ] : [["", point.displayName], ["描述性点估计", valueLabel(point.coef)], ["显示状态", suppressionCopy]];
  const description = hasCi
    ? `系数图：点估计及${CLUSTER_INTERVAL_LABEL}`
    : inferenceAllowed ? "系数图：本设计不可作推断，无置信区间" : "系数图：整体设计门禁已抑制统计推断，仅显示描述性点估计";
  return (
    <div ref={wrapRef} className="coef-plot" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}{unit ? `（${unit}）` : ""}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        {!inferenceAllowed
          ? suppressionCopy
          : `点 = 估计值${hasCi ? " · 横线 = 95% 区间" : ""} · 竖线 = 0（无效应）；区间跨过 0 时方向不确定`}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{hasCi ? `${description}；完整数值见系数表` : description}</title>
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
          const labelAt = Math.min(Math.max(x(point.coef), labelW + 24), width - padR - 24);
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
                  {x(point.hi) - x(point.lo) < 64
                    ? <text x={(x(point.lo) + x(point.hi)) / 2} y={y(index) + 22} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">[{valueLabel(point.lo)}, {valueLabel(point.hi)}]</text>
                    : <>
                      <text x={x(point.lo)} y={y(index) + 22} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">{valueLabel(point.lo)}</text>
                      <text x={x(point.hi)} y={y(index) + 22} textAnchor="middle" fontSize={10.5} fill="#5f6677" stroke="none">{valueLabel(point.hi)}</text>
                    </>}
                </g>
              )}
              <circle cx={x(point.coef)} cy={y(index)} r={6.5} fill={fill} stroke="#fff" strokeWidth={2} />
              <text x={labelAt} y={y(index) - 21} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#2a2f3a">
                {valueLabel(point.coef)}
              </text>
            </g>
          );
        })}
        <line x1={x(0)} x2={x(0)} y1={padT - 6} y2={height - padB} stroke="#1f2430" strokeWidth={1.8} />
        <text x={x(0) + 5} y={padT + 4} fontSize={10.5} fill="#5f6677">0 = 无效应</text>
      </svg>
      {Tip}
    </div>
  );
}

const BIN = "#216cc0";

/**
 * Binned scatter: the within-transformed regressor on x, the mean within-transformed outcome in each of
 * ~20 equal-count bins on y, and the fitted line through the origin with the estimated slope β. This is
 * what the regression "sees" after the fixed effects are taken out.
 */
export function BinScatterChart({ bins, slope, xLabel, yLabel, xScale = 100, yScale = 1, title = "回归在量什么" }: {
  bins: { x: number; y: number; n: number }[];
  /** β already in display units: shown Y units per one shown X unit (what the label prints). */
  slope: number;
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
  const description = `分箱散点图：横轴为扣除固定效应后的 X，纵轴为各箱 Y 的平均；直线斜率为估计的 β`;
  return (
    <div ref={wrapRef} className="binscatter-plot" style={{ ...cardStyle, flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#3a4050" }}>{title}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        每个点是 X 相近的 1/{bins.length} 单元的平均（X、Y 都已扣掉各自起点和共同年份变化）；直线斜率就是 β
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={description} style={{ display: "block", width: "100%", maxWidth: 760, height: "auto" }}>
        <title>{description}</title>
        {yAxis.ticks.map((tick) => (
          <g key={`y${tick}`}>
            <line x1={m.l} x2={W - m.r} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "#9aa3b5" : "#eef0f4"} strokeDasharray={tick === 0 ? "4 3" : undefined} />
            <text x={m.l - 8} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="#5f6677">{fy(tick)}</text>
          </g>
        ))}
        {xAxis.ticks.map((tick) => (
          <g key={`x${tick}`}>
            <line x1={x(tick)} x2={x(tick)} y1={m.t} y2={H - m.b} stroke={tick === 0 ? "#9aa3b5" : "#eef0f4"} strokeDasharray={tick === 0 ? "4 3" : undefined} />
            <text x={x(tick)} y={H - m.b + 16} textAnchor="middle" fontSize={11} fill="#5f6677">{fx(tick)}</text>
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
        <text x={x(xAxis.hi) - 6} y={y(fitted[1]) + (slope < 0 ? 16 : -8)} textAnchor="end" fontSize={11} fontWeight={700} fill={ESTIMATE}>斜率 β = {slope.toFixed(Math.abs(slope) >= 100 ? 0 : Math.abs(slope) >= 1 ? 2 : 3)}</text>
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
  estimate?: { gap: number; label: string } | null;
}) {
  const width = 640, height = 250, padL = 64, padR = 112, padT = 22, padB = 34;
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
  const label = (series: { year: number; change: number }[], text: string, color: string, dy: number) => {
    const last = series.at(-1);
    return last && <text x={x(last.year) + 8} y={y(last.change * scale) + dy} dominantBaseline="middle" fontSize={11.5} fontWeight={700} fill={color}>{text}</text>;
  };
  const lastTaxed = taxed.at(-1)?.change ?? 0, lastUntaxed = untaxed.at(-1)?.change ?? 0;
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
              <text x={bx + 7} y={(y0 + y1) / 2 + 4} fontSize={10.5} fill="#2a2f3a" stroke="none">{estimate.label}</text>
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
        {label(taxed, "加税国家组", TAXED, lastTaxed < lastUntaxed ? 8 : -8)}
        {label(untaxed, "未加税国家组", UNTAXED, lastTaxed < lastUntaxed ? -8 : 8)}
      </svg>
    </div>
  );
}
