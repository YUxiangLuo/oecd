import { globalInferenceIsSuppressed } from "../../regression-verdict";
import { CLUSTER_INTERVAL_LABEL, formatPValue } from "../../regression-statistics";
import type { RegressionStatus, TreatmentSupport } from "../../types";
import { cardStyle, useTip } from "../shared";

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

const POSITIVE = "#d64545";
const NEGATIVE = "#2f6fd0";
const NEUTRAL = "#b6bac6";

/**
 * Coefficient plot: a vertical zero line, one row per coefficient, a bar from 0 to the estimate
 * (red = positive, blue = negative) and the confidence interval as a capped whisker.
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
    stars: inferenceAllowed ? coefficient.stars : "",
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
    ["系数", `${valueLabel(point.coef)}${point.stars}`],
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
          : `条形 = 点估计（红为正、蓝为负） · ${hasCi ? `横线 = ${CLUSTER_INTERVAL_LABEL} · ` : ""}竖线 = 0；区间跨过 0 时方向不确定`}
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
          const fill = !inferenceAllowed ? NEUTRAL : point.coef >= 0 ? POSITIVE : NEGATIVE;
          const barX = Math.min(x(0), x(point.coef));
          const barW = Math.max(1, Math.abs(x(point.coef) - x(0)));
          const labelRight = point.coef >= 0;
          const labelAt = labelRight ? Math.max(x(point.coef), x(point.hi ?? point.coef)) + 6 : Math.min(x(point.coef), x(point.lo ?? point.coef)) - 6;
          return (
            <g key={point.name} onMouseEnter={(event) => show(event, tip(point))} onMouseMove={(event) => show(event, tip(point))} onMouseLeave={hide}>
              <text x={labelW - 12} y={y(index) - (parts.length > 1 ? 5 : 0)} dominantBaseline="middle" textAnchor="end" fontSize={11.5} fill="#3a4050">
                {parts.map((part, partIndex) => <tspan key={part} x={labelW - 12} dy={partIndex === 0 ? 0 : 13}>{part}</tspan>)}
              </text>
              <rect x={barX} y={y(index) - 11} width={barW} height={22} rx={2} fill={fill} fillOpacity={0.85} />
              {point.lo != null && point.hi != null && (
                <g className="coef-ci" stroke="#2a2f3a" strokeWidth={1.6}>
                  <line x1={x(point.lo)} x2={x(point.hi)} y1={y(index)} y2={y(index)} />
                  <line x1={x(point.lo)} x2={x(point.lo)} y1={y(index) - 7} y2={y(index) + 7} />
                  <line x1={x(point.hi)} x2={x(point.hi)} y1={y(index) - 7} y2={y(index) + 7} />
                </g>
              )}
              <circle cx={x(point.coef)} cy={y(index)} r={4} fill="#fff" stroke="#2a2f3a" strokeWidth={1.6} />
              <text x={labelAt} y={y(index)} dominantBaseline="middle" textAnchor={labelRight ? "start" : "end"} fontSize={11.5} fontWeight={700} fill="#2a2f3a">
                {valueLabel(point.coef)}{point.stars}
              </text>
            </g>
          );
        })}
        <line x1={x(0)} x2={x(0)} y1={padT - 6} y2={height - padB} stroke="#1f2430" strokeWidth={1.8} />
      </svg>
      {Tip}
    </div>
  );
}
