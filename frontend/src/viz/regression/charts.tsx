import { globalInferenceIsSuppressed } from "../../regression-verdict";
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
  const rowH = 48, padT = 14, padB = 30, labelW = 132, padR = 18;
  const width = 380, height = padT + pts.length * rowH + padB;
  const plotW = width - labelW - padR;
  const extent = Math.max(
    ...pts.map((point) => Math.max(Math.abs(point.lo ?? point.coef), Math.abs(point.hi ?? point.coef))),
    1e-6,
  ) * 1.12;
  const x = (value: number) => labelW + ((value + extent) / (2 * extent)) * plotW;
  const y = (index: number) => padT + (index + 0.5) * rowH;
  const format = (value: number) => (
    Math.abs(value) < 0.01 && scale === 1 ? value.toFixed(4) : value.toFixed(3)
  );
  const tip = (point: (typeof pts)[number]): [string, string][] => inferenceAllowed ? [
    ["", point.displayName],
    ["系数", `${format(point.coef)}${point.stars}`],
    ["95% CI", point.lo != null && point.hi != null ? `[${format(point.lo)}, ${format(point.hi)}]` : "不可评估"],
    ["p 值", point.p != null ? point.p.toFixed(3) : "不可评估"],
  ] : [["", point.displayName], ["描述性点估计", format(point.coef)], ["显示状态", suppressionCopy]];
  const description = hasCi
    ? "政策系数及 95% 置信区间"
    : inferenceAllowed ? "政策系数；本设计不可作推断，无置信区间" : "政策系数描述性点；整体设计门禁已抑制统计推断";
  return (
    <div ref={wrapRef} style={{ ...cardStyle, flex: "1 1 260px", minWidth: 260 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050" }}>{title}{unit ? `（${unit}）` : ""}</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        {!inferenceAllowed ? suppressionCopy : hasCi ? "点 = 估计值 · 横线 = 95% 置信区间" : "点 = 估计值 · 无置信区间"}
        {unit ? ` · 单位：${unit}` : ""}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description} style={{ display: "block", width: "100%", height: "auto" }}>
        <title>{hasCi ? `${description}；完整数值见技术细节表` : description}</title>
        <line x1={x(0)} x2={x(0)} y1={padT} y2={height - padB} stroke="#e0e3ea" strokeWidth={1} />
        {[-extent, 0, extent].map((value) => (
          <text key={value} x={x(value)} y={height - padB + 16} textAnchor="middle" fontSize={11} fill="#5f6677">
            {value === 0 ? "0" : format(value)}
          </text>
        ))}
        {pts.map((point, index) => {
          const parts = splitCoefName(point.displayName);
          return (
            <g key={point.name} onMouseEnter={(event) => show(event, tip(point))} onMouseMove={(event) => show(event, tip(point))} onMouseLeave={hide}>
              <text x={labelW - 8} y={y(index) - (parts.length > 1 ? 5 : 0)} textAnchor="end" fontSize={10.5} fill="#5a6070">
                {parts.map((part, partIndex) => <tspan key={part} x={labelW - 8} dy={partIndex === 0 ? 0 : 13}>{part}</tspan>)}
              </text>
              {point.lo != null && point.hi != null && (
                <line x1={x(point.lo)} x2={x(point.hi)} y1={y(index)} y2={y(index)} stroke="#aaa7eb" strokeWidth={4} strokeLinecap="round" />
              )}
              <circle cx={x(point.coef)} cy={y(index)} r={5.5} fill="#4b47e0" stroke="#fff" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      {Tip}
    </div>
  );
}
