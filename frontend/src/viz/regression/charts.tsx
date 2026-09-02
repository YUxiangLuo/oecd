import {
  eventInferenceGate, eventPretrendIsSafe, eventPretrendScopesAreSafe, eventSupportCoversTerms,
  GLOBAL_PRETREND_SUPPRESSION_COPY, globalInferenceIsSuppressed,
} from "../../regression-event-support";
import type { PretrendDiagnostics } from "../../regression-event-support";
import type { EventSupport, PlaceboResponse, PretrendDiagnostic, RegressionStatus, TreatmentSupport } from "../../types";
import { CAT, cardStyle, useTip } from "../shared";

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

/* --------------------------- 事件研究:系数时间轴 --------------------------- */

export function EventStudyChart({
  coefs, notes, title, seriesLabel, pretrend: legacyPretrend, pretrendDiagnostics, interaction = false,
  eventSupport, globalSupport, globalStatus, scale = 1, unit,
}: {
  coefs: { name: string; coef: number; ci_low: number | null; ci_high: number | null }[];
  notes: string[];
  title?: string;
  seriesLabel?: string;
  pretrend?: PretrendDiagnostic;
  pretrendDiagnostics?: PretrendDiagnostics;
  interaction?: boolean;
  eventSupport?: EventSupport | null;
  globalSupport?: TreatmentSupport | null;
  globalStatus?: RegressionStatus | null;
  scale?: number;
  unit?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  // Interaction responses intentionally keep diagnostics.pretrend as the legacy joint test.
  // The βₖ chart consumes the main test only after validating the complete scope set.
  const pretrend = interaction
    ? pretrendDiagnostics?.pretrend_tests?.main ?? pretrendDiagnostics?.pretrend ?? legacyPretrend
    : legacyPretrend;
  const pretrendScopeSetIsSafe = !interaction
    || eventPretrendScopesAreSafe(eventSupport, pretrendDiagnostics, true);
  const validEventSupport = eventSupportCoversTerms(eventSupport, coefs.map((coefficient) => coefficient.name));
  const safePretrend = pretrendScopeSetIsSafe
    && validEventSupport && pretrend != null && eventPretrendIsSafe(eventSupport, pretrend);
  const globallySuppressed = globalInferenceIsSuppressed(globalStatus, globalSupport);
  const globalReason = (Array.isArray(globalSupport?.reasons) ? globalSupport.reasons.join(" ") : "")
    || "整体设计门禁已抑制统计推断；点估计仅作描述，不显示 p 值或置信区间。";
  // 整体门禁优先；其次逐期支持。旧快照即使携带区间也只能画描述性点。
  const pts = scaleForestCoefs(coefs, scale).map((c) => {
    const gate = eventInferenceGate(eventSupport, c.name);
    return {
      ...c,
      lo: !globallySuppressed && gate.state === "supported" ? c.ci_low : null,
      hi: !globallySuppressed && gate.state === "supported" ? c.ci_high : null,
      gate,
    };
  });
  const hasCi = pts.some((p) => p.lo != null && p.hi != null);
  const unsupported = pts.filter((p) => p.gate.state !== "supported");
  const mixedSupport = unsupported.length > 0 && unsupported.length < pts.length;
  const W = 640, H = 240, padL = 56, padR = 24, padT = 18, padB = 34;
  const ext = Math.max(
    ...pts.map((p) => Math.max(Math.abs(p.lo ?? p.coef), Math.abs(p.hi ?? p.coef))),
    1e-6,
  ) * 1.15;
  const x = (i: number) => padL + ((i + 0.5) / pts.length) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v + ext) / (2 * ext)) * (H - padT - padB);
  const fmt = (v: number) => (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3));
  return (
    <div ref={wrapRef} style={{ ...cardStyle, marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050", marginBottom: 6 }}>
        {title ?? "事件研究:处理效应的动态路径"}
        {globallySuppressed
          ? "（整体设计门禁已抑制推断，仅显示方形描述性点）"
          : mixedSupport
            ? "（支持充分期：点和 95% 置信区间；支持不足/未知期：菱形描述性点）"
            : hasCi
              ? "（点 = 系数，须 = 95% 置信区间）"
              : "（逐期支持不足或未知，仅显示描述性点）"}
        {unit ? ` · 单位：${unit}` : ""}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title ?? "事件研究动态路径"}：${globallySuppressed ? "整体设计门禁已抑制推断，只显示描述性方形点" : "支持充分期显示 95% 置信区间；支持不足或未知期只显示描述性菱形点"}`} style={{ display: "block", width: "100%", height: "auto" }}>
        <title>{`${title ?? "事件研究动态路径"}：${globallySuppressed ? "整体设计门禁已抑制推断，只显示描述性方形点" : "支持充分期显示 95% 置信区间；支持不足或未知期只显示描述性菱形点"}`}</title>
        {[-ext, -ext / 2, ext / 2, ext].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#f0f1f6" strokeWidth={1} />
            <text x={padL - 8} y={y(v) + 3.5} textAnchor="end" fontSize={11} fill="#5f6677"
              fontFamily="inherit" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="#c3c6d1" strokeWidth={1} />
        <text x={padL - 8} y={y(0) + 3.5} textAnchor="end" fontSize={10} fill="#5f6677">0</text>
        {pts.map((p, i) => (
          <g key={p.name}
            onMouseEnter={(e) => show(e, [
              ["", seriesLabel ? `${seriesLabel} · ${p.name}` : p.name],
              ["系数", fmt(p.coef)],
              ["推断状态", globallySuppressed ? "整体设计门禁已抑制推断" : p.gate.state === "supported" ? "逐期支持充分" : p.gate.state === "unsupported" ? "逐期支持不足，推断已抑制" : "逐期支持未知，推断不可用"],
              ["逐期支持", p.gate.state === "supported" ? `${p.gate.period.contributing_clusters} 个贡献聚类` : p.gate.state === "unsupported" ? `${p.gate.period.contributing_clusters} 个贡献聚类` : "未知"],
              ["95% CI", p.lo != null && p.hi != null ? `[${fmt(p.lo)}, ${fmt(p.hi)}]` : "不可评估"],
            ])}
            onMouseMove={(e) => show(e, [
              ["", seriesLabel ? `${seriesLabel} · ${p.name}` : p.name],
              ["系数", fmt(p.coef)],
              ["推断状态", globallySuppressed ? "整体设计门禁已抑制推断" : p.gate.state === "supported" ? "逐期支持充分" : p.gate.state === "unsupported" ? "逐期支持不足，推断已抑制" : "逐期支持未知，推断不可用"],
              ["逐期支持", p.gate.state === "supported" ? `${p.gate.period.contributing_clusters} 个贡献聚类` : p.gate.state === "unsupported" ? `${p.gate.period.contributing_clusters} 个贡献聚类` : "未知"],
              ["95% CI", p.lo != null && p.hi != null ? `[${fmt(p.lo)}, ${fmt(p.hi)}]` : "不可评估"],
            ])}
            onMouseLeave={hide} style={{ cursor: "default" }}>
            <title>{`${p.name}，系数 ${fmt(p.coef)}，${globallySuppressed ? "整体设计门禁已抑制推断" : p.gate.state === "supported" ? "逐期支持充分" : p.gate.state === "unsupported" ? `${p.gate.period.contributing_clusters} 个贡献聚类，逐期推断已抑制` : "逐期支持未知，推断不可用"}`}</title>
            <rect x={x(i) - 14} y={padT} width={28} height={H - padT - padB} fill="transparent" />
            {p.lo != null && p.hi != null && (
              <line x1={x(i)} x2={x(i)} y1={y(p.lo)} y2={y(p.hi)} stroke={CAT[0]} strokeWidth={2} strokeLinecap="round" />
            )}
            {globallySuppressed ? (
              <rect x={x(i) - 5} y={y(p.coef) - 5} width={10} height={10} fill="#fff" stroke="#7c3aed" strokeWidth={2} />
            ) : p.gate.state === "supported" ? (
              <circle cx={x(i)} cy={y(p.coef)} r={5} fill={CAT[0]} stroke="#fff" strokeWidth={2} />
            ) : (
              <path
                d={`M ${x(i)} ${y(p.coef) - 6} L ${x(i) + 6} ${y(p.coef)} L ${x(i)} ${y(p.coef) + 6} L ${x(i) - 6} ${y(p.coef)} Z`}
                fill="#fff"
                stroke="#b45309"
                strokeWidth={2}
              />
            )}
            <text x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize={11} fill="#5a6070"
              style={{ fontVariantNumeric: "tabular-nums" }}>{p.name}</text>
          </g>
        ))}
      </svg>
      <div style={{ marginTop: 6, fontSize: 11, color: "#5f6677", lineHeight: 1.65 }}>
        <div>{notes.find((n) => n.includes("基期")) ?? "基期为冲击前一年（系数归一为 0，不在图中）"}</div>
        {globallySuppressed && <div><b>整体设计门禁：</b>{globalReason}</div>}
        {pretrend && globallySuppressed && (
          <div><b>冲击前趋势检查：</b>{GLOBAL_PRETREND_SUPPRESSION_COPY}</div>
        )}
        {pretrend && !globallySuppressed && pretrend.reason === "global_inference_suppressed" && (
          <div><b>冲击前趋势检查：</b>诊断已损坏或状态未知：诊断声称整体推断已抑制，但当前结果并未触发整体门禁。</div>
        )}
        {safePretrend && !globallySuppressed && pretrend.reason !== "global_inference_suppressed" && (
          <div><b>冲击前趋势检查：</b>{pretrend.interpretation}</div>
        )}
        {pretrend && !safePretrend && !globallySuppressed && pretrend.reason !== "global_inference_suppressed" && (
          <div><b>冲击前趋势检查：</b>逐期支持未知或诊断已损坏；既有统计量与解释不可用于教学推断。</div>
        )}
        {unsupported.map((period) => (
          <div key={period.name}>
            <b>{period.name}：</b>
            {period.gate.state === "unsupported"
              ? period.gate.period.reasons.join(" ")
              : "缺少逐事件期支持契约；旧结果的区间与显著性不可用于教学结论。"}
          </div>
        ))}
      </div>
      {Tip}
    </div>
  );
}

/* -------------------------- 步骤11–14：非校准实体置换分布 -------------------------- */

export function PlaceboChart({ data, scale = 1, unit }: {
  data: PlaceboResponse["placebo"];
  scale?: number;
  unit?: string;
}) {
  const values = data.placebo_coefs.map((value) => value * scale);
  const trueCoef = data.true_coef * scale;
  const all = [...values, trueCoef];
  const lo0 = Math.min(...all), hi0 = Math.max(...all);
  const pad = (hi0 - lo0) * 0.08 || Math.abs(hi0) * 0.12 || 0.1;
  const lo = lo0 - pad, hi = hi0 + pad;
  const bins = 14;
  const counts = Array.from({ length: bins }, () => 0);
  values.forEach((v) => {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo || 1)) * bins)));
    counts[idx] += 1;
  });
  const W = 640, H = 230, m = { l: 48, r: 20, t: 20, b: 38 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
  const maxCount = Math.max(...counts, 1);
  const x = (v: number) => m.l + ((v - lo) / (hi - lo || 1)) * plotW;
  const y = (c: number) => m.t + plotH - (c / maxCount) * plotH;
  const zeroIn = lo < 0 && hi > 0;

  return (
    <div style={{ ...cardStyle, marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050", marginBottom: 6 }}>
        实体置换敏感性分析（非校准）：伪处理估计值分布{unit ? ` · 单位：${unit}` : ""}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="非校准实体置换的伪处理估计值分布；竖线为原始分组估计值" style={{ display: "block", width: "100%", height: "auto" }}>
        <title>非校准实体置换的伪处理估计值分布；竖线为原始分组估计值</title>
        {zeroIn && <line x1={x(0)} x2={x(0)} y1={m.t} y2={H - m.b} stroke="#cfd3dd" strokeDasharray="4 4" />}
        {counts.map((c, i) => {
          const x0 = m.l + (i / bins) * plotW + 2;
          const bw = plotW / bins - 4;
          return (
            <rect
              key={i}
              x={x0}
              y={y(c)}
              width={Math.max(1, bw)}
              height={H - m.b - y(c)}
              fill={CAT[0]}
              fillOpacity={0.68}
              rx={3}
            />
          );
        })}
        <line x1={x(trueCoef)} x2={x(trueCoef)} y1={m.t - 4} y2={H - m.b} stroke={CAT[5]} strokeWidth={2.5} />
        <text x={x(trueCoef)} y={m.t - 8} textAnchor="middle" fontSize={11} fill={CAT[5]} fontWeight={700}>
          原始分组估计值
        </text>
        {[lo, 0, hi].filter((v, i, arr) => (i === 0 || v !== arr[i - 1]) && v >= lo && v <= hi).map((v) => (
          <text key={v} x={x(v)} y={H - 14} textAnchor="middle" fontSize={10.5} fill="#5f6677">
            {v.toFixed(3)}
          </text>
        ))}
      </svg>
      <div style={{ fontSize: 11.5, color: "#5a6070", lineHeight: 1.7 }}>
        实际完成 {data.n_draws}/{data.requested_draws} 次置换 · 原处理个体 {data.treated_entities}/{data.total_entities} ·
        cohort={Object.entries(data.cohorts).map(([y, n]) => `${y}:${n}`).join("、")} ·
        描述性尾部占比={data.tail_share.toFixed(3)}（非 p 值）
      </div>
      {data.n_draws < data.requested_draws && (
        <div role="alert" style={{ marginTop: 7, padding: "7px 10px", borderRadius: 7, background: "#fff5e8", color: "#9a5a00", fontSize: 11.5 }}>
          有 {data.requested_draws - data.n_draws} 次置换未得到有效估计；尾部占比基于实际完成次数，且不构成校准推断。
        </div>
      )}
    </div>
  );
}

/* --------------------- 步骤11–14：系数森林图（横向 CI） --------------------- */

/** 长系数名折成两行:优先在最靠近中点的分隔符(×、_、空格)处断行,避免截断记号。 */
function splitCoefName(name: string): string[] {
  if (name.includes("×base_gvc")) return [name.replace("×base_gvc", ""), "×base_gvc"];
  if (name.length <= 16) return [name];
  const mid = Math.ceil(name.length / 2);
  let breakAt = -1;
  for (let i = 1; i < name.length - 1; i++) {
    if ("×_ ".includes(name[i]) && (breakAt === -1 || Math.abs(i - mid) < Math.abs(breakAt - mid))) breakAt = i;
  }
  if (breakAt === -1) return [name.slice(0, mid), name.slice(mid)];
  // × 归到第二行行首(读作运算符),_ 与空格留在第一行行尾。
  const cut = name[breakAt] === "×" ? breakAt : breakAt + 1;
  return [name.slice(0, cut), name.slice(cut)];
}

/** 点=估计值,横条=95% 置信区间,竖线=0 轴;负效应红、正效应绿(与系数表一致)。 */
export function CoefForestChart({
  coefs, globalStatus, globalSupport, scale = 1, unit,
}: {
  coefs: { name: string; coef: number; ci_low: number | null; ci_high: number | null; p: number | null; stars: string }[];
  globalStatus?: RegressionStatus | null;
  globalSupport?: TreatmentSupport | null;
  scale?: number;
  unit?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const globallySuppressed = globalInferenceIsSuppressed(globalStatus, globalSupport);
  const inferenceAllowed = !globallySuppressed;
  const globalSuppressionCopy = "整体设计门禁已抑制统计推断；仅显示描述性点估计。";
  // 推断被抑制时只画点:零宽度的区间横条会被读成“估计极其精确”。
  const pts = scaleForestCoefs(coefs, scale).map((c) => ({
    ...c,
    p: inferenceAllowed ? c.p : null,
    stars: inferenceAllowed ? c.stars : "",
    lo: inferenceAllowed ? c.ci_low : null,
    hi: inferenceAllowed ? c.ci_high : null,
  }));
  const hasCi = pts.some((p) => p.lo != null && p.hi != null);
  const rowH = 48, padT = 14, padB = 30, labelW = 132, padR = 18;
  const W = 380, H = padT + pts.length * rowH + padB;
  const plotW = W - labelW - padR;
  const ext = Math.max(
    ...pts.map((p) => Math.max(Math.abs(p.lo ?? p.coef), Math.abs(p.hi ?? p.coef))),
    1e-6,
  ) * 1.12;
  const x = (v: number) => labelW + ((v + ext) / (2 * ext)) * plotW;
  const y = (i: number) => padT + (i + 0.5) * rowH;
  const fmt = (v: number) => (Math.abs(v) < 0.01 && scale === 1 ? v.toFixed(4) : v.toFixed(scale === 100 ? 2 : 3));
  const tip = (p: (typeof pts)[number]): [string, string][] => inferenceAllowed ? [
    ["", p.name],
    ["系数", `${fmt(p.coef)}${p.stars}`],
    ["95% CI", p.lo != null && p.hi != null ? `[${fmt(p.lo)}, ${fmt(p.hi)}]` : "不可评估"],
    ["p 值", p.p != null ? p.p.toFixed(3) : "不可评估"],
  ] : [
    ["", p.name],
    ["描述性点估计", fmt(p.coef)],
    ["显示状态", globalSuppressionCopy],
  ];
  const chartDescription = hasCi
    ? "政策系数及 95% 置信区间"
    : globallySuppressed
      ? "政策系数描述性点；整体设计门禁已抑制统计推断"
      : "政策系数；本设计不可作推断，无置信区间";
  return (
    <div ref={wrapRef} style={{ ...cardStyle, flex: "1 1 260px", minWidth: 260 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050" }}>系数图</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        {globallySuppressed
          ? globalSuppressionCopy
          : hasCi
            ? "点 = 估计值 · 横线 = 95% 置信区间"
            : "点 = 估计值 · 本设计不可作推断,无置信区间"}
        {unit ? ` · 单位：${unit}` : ""}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chartDescription} style={{ display: "block", width: "100%", height: "auto" }}>
        <title>{hasCi ? `${chartDescription}；完整数值见技术细节表` : chartDescription}</title>
        <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} stroke="#e0e3ea" strokeWidth={1} />
        {[-ext, 0, ext].map((v) => (
          <text key={v} x={x(v)} y={H - padB + 16} textAnchor="middle" fontSize={11} fill="#5f6677"
            style={{ fontVariantNumeric: "tabular-nums" }}>{v === 0 ? "0" : fmt(v)}</text>
        ))}
        {pts.map((p, i) => {
          const dot = "#4b47e0";
          const ci = "#aaa7eb";
          const parts = splitCoefName(p.name);
          return (
            <g key={p.name}
              onMouseEnter={(e) => show(e, tip(p))}
              onMouseMove={(e) => show(e, tip(p))}
              onMouseLeave={hide} style={{ cursor: "default" }}>
              <rect x={labelW} y={y(i) - rowH / 2} width={plotW} height={rowH} fill="transparent" />
              <text x={labelW - 8} y={y(i) - (parts.length > 1 ? 5 : 0)} textAnchor="end" fontSize={10.5} fill="#5a6070">
                {parts.map((part, partIndex) => (
                  <tspan key={partIndex} x={labelW - 8} dy={partIndex === 0 ? 0 : 13}>{part}</tspan>
                ))}
              </text>
              {p.lo != null && p.hi != null && (
                <line x1={x(p.lo)} x2={x(p.hi)} y1={y(i)} y2={y(i)} stroke={ci} strokeWidth={4} strokeLinecap="round" />
              )}
              <circle cx={x(p.coef)} cy={y(i)} r={5.5} fill={dot} stroke="#fff" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      {Tip}
    </div>
  );
}
