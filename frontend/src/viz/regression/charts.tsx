import type { PlaceboResponse, PretrendDiagnostic } from "../../types";
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

export function EventStudyChart({ coefs, notes, title, seriesLabel, pretrend, scale = 1, unit }: {
  coefs: { name: string; coef: number; ci_low: number | null; ci_high: number | null }[];
  notes: string[];
  title?: string;
  seriesLabel?: string;
  pretrend?: PretrendDiagnostic;
  scale?: number;
  unit?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  // 推断被抑制时没有区间:只画点,不画须。否则 null→0 会把“不可评估”
  // 画成一条零宽度的须,视觉上等于“估计极其精确”,恰好是反教学效果。
  const pts = scaleForestCoefs(coefs, scale).map((c) => ({ ...c, lo: c.ci_low, hi: c.ci_high }));
  const hasCi = pts.some((p) => p.lo != null && p.hi != null);
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
        {hasCi ? "(点 = 系数,须 = 95% 置信区间)" : "(点 = 系数;本设计不可作推断,无置信区间)"}
        {unit ? ` · 单位：${unit}` : ""}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title ?? "事件研究动态路径"}：点为系数${hasCi ? "，竖线为 95% 置信区间" : "；本设计不可作推断，无置信区间"}`} style={{ display: "block", width: "100%", height: "auto" }}>
        <title>{title ?? "事件研究动态路径"}：点为系数{hasCi ? "，竖线为 95% 置信区间" : "；本设计不可作推断，无置信区间"}</title>
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
              ["95% CI", p.lo != null && p.hi != null ? `[${fmt(p.lo)}, ${fmt(p.hi)}]` : "不可评估"],
            ])}
            onMouseMove={(e) => show(e, [
              ["", seriesLabel ? `${seriesLabel} · ${p.name}` : p.name],
              ["系数", fmt(p.coef)],
              ["95% CI", p.lo != null && p.hi != null ? `[${fmt(p.lo)}, ${fmt(p.hi)}]` : "不可评估"],
            ])}
            onMouseLeave={hide} style={{ cursor: "default" }}>
            <rect x={x(i) - 14} y={padT} width={28} height={H - padT - padB} fill="transparent" />
            {p.lo != null && p.hi != null && (
              <line x1={x(i)} x2={x(i)} y1={y(p.lo)} y2={y(p.hi)} stroke={CAT[0]} strokeWidth={2} strokeLinecap="round" />
            )}
            <circle cx={x(i)} cy={y(p.coef)} r={5} fill={CAT[0]} stroke="#fff" strokeWidth={2} />
            <text x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize={11} fill="#5a6070"
              style={{ fontVariantNumeric: "tabular-nums" }}>{p.name}</text>
          </g>
        ))}
      </svg>
      <div style={{ marginTop: 6, fontSize: 11, color: "#5f6677", lineHeight: 1.65 }}>
        <div>{notes.find((n) => n.includes("基期")) ?? "基期为冲击前一年（系数归一为 0，不在图中）"}</div>
        {pretrend && <div><b>冲击前趋势检查：</b>{pretrend.interpretation}</div>}
      </div>
      {Tip}
    </div>
  );
}

/* -------------------------- 步骤12–15：非校准实体置换分布 -------------------------- */

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

/* --------------------- 步骤12–15：系数森林图（横向 CI） --------------------- */

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
export function CoefForestChart({ coefs, scale = 1, unit }: {
  coefs: { name: string; coef: number; ci_low: number | null; ci_high: number | null; p: number | null; stars: string }[];
  scale?: number;
  unit?: string;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  // 推断被抑制时只画点:零宽度的区间横条会被读成“估计极其精确”。
  const pts = scaleForestCoefs(coefs, scale).map((c) => ({ ...c, lo: c.ci_low, hi: c.ci_high }));
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
  const tip = (p: (typeof pts)[number]): [string, string][] => [
    ["", p.name],
    ["系数", `${fmt(p.coef)}${p.stars}`],
    ["95% CI", p.lo != null && p.hi != null ? `[${fmt(p.lo)}, ${fmt(p.hi)}]` : "不可评估"],
    ["p 值", p.p != null ? p.p.toFixed(3) : "不可评估"],
  ];
  return (
    <div ref={wrapRef} style={{ ...cardStyle, flex: "1 1 260px", minWidth: 260 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050" }}>系数图</div>
      <div style={{ fontSize: 11, color: "#5f6677", marginBottom: 6 }}>
        {hasCi ? "点 = 估计值 · 横线 = 95% 置信区间" : "点 = 估计值 · 本设计不可作推断,无置信区间"}
        {unit ? ` · 单位：${unit}` : ""}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={hasCi ? "政策系数及 95% 置信区间" : "政策系数；本设计不可作推断，无置信区间"} style={{ display: "block", width: "100%", height: "auto" }}>
        <title>{hasCi ? "政策系数及 95% 置信区间；完整数值见技术细节表" : "政策系数；本设计不可作推断，无置信区间"}</title>
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
