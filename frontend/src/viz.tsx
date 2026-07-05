/**
 * 步骤8-11 富可视化 + 事件研究系数图。
 *
 * 设计遵循 dataviz 方法:类别色按固定槽位分配(已跑 validate_palette.js,
 * 白底最差相邻 CVD ΔE 24.2 通过;aqua/yellow 对比度不足按救济规则以
 * 可见标签 + 表格视图补偿);细标记、段间 2px 留白、悬停 tooltip 不设门槛
 * (所有数值同时可在表格视图读取);文本一律用文字色,不穿系列色。
 */
import { useMemo, useRef, useState } from "react";
import type { NetworkData } from "./types";

// 固定顺序的类别槽位(经校验的默认调色板,前 6 位)
export const CAT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948"];
// 顺序色(蓝,浅→深),用于热力表
const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

const REGIONS = ["东亚", "东南亚·南亚", "欧洲", "美洲", "中东·非洲", "大洋洲·其他"] as const;
const REGION_OF: Record<string, number> = {};
(
  [
    ["CHN JPN KOR TWN HKG", 0],
    ["VNM THA MYS IDN PHL SGP KHM LAO MMR BRN IND BGD PAK", 1],
    ["AUT BEL BGR BLR CHE CYP CZE DEU DNK ESP EST FIN FRA GBR GRC HRV HUN IRL ISL ITA LTU LUX LVA MLT NLD NOR POL PRT ROU RUS SVK SVN SWE TUR UKR", 2],
    ["USA CAN MEX ARG BRA CHL COL CRI PER", 3],
    ["SAU ISR JOR EGY MAR TUN NGA ZAF CIV CMR SEN", 4],
    ["AUS NZL KAZ ROW", 5],
  ] as const
).forEach(([codes, r]) => codes.split(" ").forEach((c) => (REGION_OF[c] = r)));

/* ---------------------------------- 共用 ---------------------------------- */

type Row = Record<string, string | number | null>;
const num = (v: string | number | null | undefined) => (typeof v === "number" ? v : 0);
const rowName = (r: Row) => String(r.sector ?? r.country);

/** 暗色悬浮 tooltip(增强通道;全部数值同时可在表格视图获得) */
function useTip() {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const show = (e: React.MouseEvent, lines: [string, string][]) => {
    const box = boxRef.current, wrap = wrapRef.current;
    if (!box || !wrap) return;
    box.replaceChildren(
      ...lines.map(([label, value], i) => {
        const div = document.createElement("div");
        if (i === 0) { div.style.cssText = "font-weight:700;font-size:12.5px;margin-bottom:3px"; div.textContent = value; }
        else {
          const b = document.createElement("b");
          b.style.cssText = "color:#fff;font-weight:600";
          b.textContent = value;
          const span = document.createElement("span");
          span.style.color = "#c8ccd6";
          span.textContent = `${label} · `;
          div.append(span, b);
        }
        return div;
      }),
    );
    const r = wrap.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 12;
    if (x > r.width - 190) x = e.clientX - r.left - 195;
    box.style.left = `${x}px`; box.style.top = `${y}px`; box.style.opacity = "1";
  };
  const hide = () => { if (boxRef.current) boxRef.current.style.opacity = "0"; };
  const Tip = (
    <div ref={boxRef} style={{
      position: "absolute", pointerEvents: "none", opacity: 0, transition: "opacity .12s",
      background: "#1b1f2b", color: "#fff", padding: "9px 12px", borderRadius: 10,
      fontSize: 11.5, lineHeight: 1.75, boxShadow: "0 8px 24px rgba(0,0,0,.22)", zIndex: 6, minWidth: 150,
    }} />
  );
  return { wrapRef, Tip, show, hide };
}

function Legend({ items }: { items: { name: string; color: string; line?: boolean }[] }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
      {items.map((it) => (
        <div key={it.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={it.line
            ? { width: 14, height: 2, borderRadius: 2, background: it.color }
            : { width: 11, height: 11, borderRadius: 3, background: it.color }} />
          <span style={{ fontSize: 11.5, color: "#5a6070" }}>{it.name}</span>
        </div>
      ))}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  position: "relative", background: "#fff", border: "1px solid #e7e9f0",
  borderRadius: 16, padding: "20px 22px",
};

/* ------------------------------ 步骤8:网络图 ------------------------------ */

type NetworkMetric = "share_trade_gvc_participation" | "betweenness_centrality" | "trade_gross_exports";
type NetworkColorMode = "region" | NetworkMetric;

const NETWORK_METRICS: { key: NetworkMetric; label: string; format: "pct" | "number" | "amount" }[] = [
  { key: "share_trade_gvc_participation", label: "GVC 参与度", format: "pct" },
  { key: "betweenness_centrality", label: "介数中心性", format: "number" },
  { key: "trade_gross_exports", label: "毛出口", format: "amount" },
];

function fmtNetworkMetric(value: number, format: "pct" | "number" | "amount") {
  if (format === "pct") return `${(value * 100).toFixed(1)}%`;
  if (format === "amount") return value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  return value.toFixed(3);
}

function seqColor(value: number, max: number) {
  const idx = Math.min(SEQ.length - 1, Math.floor((value / Math.max(max, 1e-9)) * SEQ.length));
  return SEQ[idx];
}

export function NetworkViz({ data }: { data: NetworkData }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sizeMetric, setSizeMetric] = useState<NetworkMetric>("share_trade_gvc_participation");
  const [colorMode, setColorMode] = useState<NetworkColorMode>("region");
  const [edgeThreshold, setEdgeThreshold] = useState(0);

  const model = useMemo(() => {
    const W = 1000, H = 660, cx = W / 2, cy = H / 2;
    const byRegion: string[][] = REGIONS.map(() => []);
    const metrics: Record<NetworkMetric, Record<string, number>> = {
      share_trade_gvc_participation: {},
      betweenness_centrality: {},
      trade_gross_exports: {},
    };
    data.nodes.forEach((n) => {
      const c = String(n.country);
      NETWORK_METRICS.forEach((m) => {
        metrics[m.key][c] = num(n[m.key]);
      });
      byRegion[REGION_OF[c] ?? 5].push(c);
    });
    byRegion.forEach((list) =>
      list.sort((a, b) => metrics.share_trade_gvc_participation[b] - metrics.share_trade_gvc_participation[a]));

    // 每个区域一个锚点,成员沿环排布;记录“朝外”单位向量供标签放射避让
    const pos: Record<string, { x: number; y: number; ox: number; oy: number }> = {};
    byRegion.forEach((list, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / REGIONS.length;
      const ax = cx + Math.cos(a) * 300, ay = cy + Math.sin(a) * 208;
      const ring = Math.min(118, 16 + list.length * 3.1);
      list.forEach((c, j) => {
        const t = (j / Math.max(1, list.length)) * 2 * Math.PI - Math.PI / 2;
        const inner = list.length > 18 && j % 2 === 1;
        const r = list.length === 1 ? 0 : ring * (inner ? 0.62 : 1);
        pos[c] = {
          x: ax + Math.cos(t) * r, y: ay + Math.sin(t) * r,
          // 内环节点朝内挪标签会撞外环,统一朝外;单节点区域沿画布中心向外
          ox: list.length === 1 ? Math.cos(a) : Math.cos(t) * (inner ? -1 : 1),
          oy: list.length === 1 ? Math.sin(a) : Math.sin(t) * (inner ? -1 : 1),
        };
      });
    });

    const maxFlow = Math.max(...data.edges.map((e) => num(e.flow)), 1);
    const maxMetric: Record<NetworkMetric, number> = {
      share_trade_gvc_participation: Math.max(...Object.values(metrics.share_trade_gvc_participation), 1e-9),
      betweenness_centrality: Math.max(...Object.values(metrics.betweenness_centrality), 1e-9),
      trade_gross_exports: Math.max(...Object.values(metrics.trade_gross_exports), 1e-9),
    };
    // 往返两条有向边合并为一个伙伴(流量相加),避免 tooltip 里同一国家出现两次
    const nbFlow: Record<string, Record<string, number>> = {};
    data.edges.forEach((e) => {
      const s = String(e.source), t = String(e.target), f = num(e.flow);
      (nbFlow[s] ??= {})[t] = (nbFlow[s]?.[t] ?? 0) + f;
      (nbFlow[t] ??= {})[s] = (nbFlow[t]?.[s] ?? 0) + f;
    });
    const neighbors: Record<string, { c: string; flow: number }[]> = {};
    Object.entries(nbFlow).forEach(([c, m]) => {
      neighbors[c] = Object.entries(m).map(([p, flow]) => ({ c: p, flow }))
        .sort((a, b) => b.flow - a.flow);
    });

    // 静态标签只给贸易流量最大的节点(区域内前 2),其余悬停时显示,避免密集区碰撞
    const flowSum: Record<string, number> = {};
    Object.entries(neighbors).forEach(([c, l]) => { flowSum[c] = l.reduce((s, n) => s + n.flow, 0); });
    const topLabeled = new Set<string>();
    byRegion.forEach((list) =>
      [...list].sort((a, b) => (flowSum[b] ?? 0) - (flowSum[a] ?? 0)).slice(0, 2)
        .forEach((c) => topLabeled.add(c)));
    return { W, H, pos, metrics, maxMetric, maxFlow, neighbors, topLabeled };
  }, [data]);

  const { W, H, pos, metrics, maxMetric, maxFlow, neighbors, topLabeled } = model;
  const focus = hovered ?? selected;
  const adj = focus ? new Set([focus, ...(neighbors[focus] ?? []).map((n) => n.c)]) : null;
  const visibleEdges = data.edges.filter((e) => num(e.flow) / maxFlow >= edgeThreshold);
  const metricMeta = Object.fromEntries(NETWORK_METRICS.map((m) => [m.key, m])) as Record<NetworkMetric, typeof NETWORK_METRICS[number]>;
  const nodeColor = (c: string) =>
    colorMode === "region"
      ? CAT[REGION_OF[c] ?? 5]
      : seqColor(metrics[colorMode][c] ?? 0, maxMetric[colorMode]);
  const tooltipLines = (c: string): [string, string][] => [
    ["", `${c} · ${REGIONS[REGION_OF[c] ?? 5]}`],
    ...NETWORK_METRICS.map((m) => [m.label, fmtNetworkMetric(metrics[m.key][c] ?? 0, m.format)] as [string, string]),
    ["主要伙伴", (neighbors[c] ?? []).slice(0, 4).map((n) => n.c).join("、") || "—"],
  ];
  const selectedNeighbors = selected ? neighbors[selected] ?? [] : [];

  return (
    <div ref={wrapRef} className="network-card" style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
      <div className="network-toolbar">
        <label>节点大小</label>
        <select value={sizeMetric} onChange={(e) => setSizeMetric(e.target.value as NetworkMetric)}>
          {NETWORK_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        <label>节点颜色</label>
        <select value={colorMode} onChange={(e) => setColorMode(e.target.value as NetworkColorMode)}>
          <option value="region">区域</option>
          {NETWORK_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        <label>边权阈值</label>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={edgeThreshold}
          onChange={(e) => setEdgeThreshold(Number(e.target.value))}
        />
        <b>{(edgeThreshold * 100).toFixed(0)}%</b>
        {selected && <button onClick={() => setSelected(null)}>清除选择</button>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }} onClick={() => setSelected(null)}>
        <g>
          {visibleEdges.map((e, i) => {
            const s = String(e.source), t = String(e.target);
            const p1 = pos[s], p2 = pos[t];
            if (!p1 || !p2) return null;
            const f = num(e.flow) / maxFlow;
            const col = colorMode === "region" ? CAT[REGION_OF[s] ?? 5] : nodeColor(s);
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const off = Math.hypot(dx, dy) * 0.14, nl = Math.hypot(-dy, dx) || 1;
            const active = !adj || s === focus || t === focus;
            return (
              <path key={i} fill="none" stroke={col}
                d={`M${p1.x} ${p1.y} Q${mx - (dy / nl) * off} ${my + (dx / nl) * off} ${p2.x} ${p2.y}`}
                strokeOpacity={active ? 0.16 + f * 0.48 : 0.025}
                strokeWidth={0.7 + f * 3.8} strokeLinecap="round" />
            );
          })}
        </g>
        <g>
          {Object.keys(pos).map((c) => {
            const p = pos[c];
            const r = 3.5 + ((metrics[sizeMetric][c] ?? 0) / Math.max(maxMetric[sizeMetric], 1e-9)) * 11;
            const col = nodeColor(c);
            const dim = adj ? !adj.has(c) : false;
            const labeled = focus ? adj!.has(c) : topLabeled.has(c);
            return (
              <g key={c} transform={`translate(${p.x} ${p.y})`} opacity={dim ? 0.18 : 1}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected((current) => current === c ? null : c);
                }}
                onMouseEnter={(e) => {
                  setHovered(c);
                  show(e, tooltipLines(c));
                }}
                onMouseMove={(e) => hovered === c && show(e, tooltipLines(c))}
                onMouseLeave={() => { setHovered(null); hide(); }}>
                <circle r={Math.max(12, r + 6)} fill={col} fillOpacity={selected === c ? 0.22 : 0.12} />
                <circle r={r} fill={col} stroke="#fff" strokeWidth={2} />
                {labeled && (
                  <text x={p.ox * (r + 7)} y={p.oy * (r + 9) + 4}
                    textAnchor={p.ox > 0.35 ? "start" : p.ox < -0.35 ? "end" : "middle"}
                    fontSize={11} fontWeight={500} fill="#3a4050"
                    stroke="#fff" strokeWidth={3} paintOrder="stroke"
                    style={{ pointerEvents: "none" }}>{c}</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div style={{ position: "absolute", left: 18, top: 68, maxWidth: 360 }}>
        <Legend items={
          colorMode === "region"
            ? REGIONS.map((r, i) => ({ name: r, color: CAT[i] }))
            : SEQ.map((color, i) => ({ name: i === 0 ? "低" : i === SEQ.length - 1 ? "高" : "", color })).filter((it) => it.name)
        } />
      </div>
      {selected && (
        <div className="network-detail">
          <div className="network-detail-head">
            <strong>{selected}</strong>
            <button onClick={() => setSelected(null)}>×</button>
          </div>
          <div className="network-detail-grid">
            {NETWORK_METRICS.map((m) => (
              <div key={m.key}>
                <span>{m.label}</span>
                <b>{fmtNetworkMetric(metrics[m.key][selected] ?? 0, m.format)}</b>
              </div>
            ))}
          </div>
          <table>
            <thead><tr><th>伙伴</th><th>双边流量</th></tr></thead>
            <tbody>
              {selectedNeighbors.slice(0, 8).map((n) => (
                <tr key={n.c}><td>{n.c}</td><td>{fmtNetworkMetric(n.flow, "amount")}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ position: "absolute", right: 18, bottom: 14, fontSize: 10.5, color: "#b0b5c2", textAlign: "right", lineHeight: 1.6 }}>
        节点大小 = {metricMeta[sizeMetric].label} · 节点颜色 = {colorMode === "region" ? "区域" : metricMeta[colorMode].label}<br />
        显示 {visibleEdges.length}/{data.edges.length} 条 Top 边;点击节点锁定贸易伙伴明细
      </div>
      {Tip}
    </div>
  );
}

/* --------------------------- 步骤9:生产结构堆叠条 --------------------------- */

const PROD_SEGS = [
  { key: "share_prod_pure_domestic", name: "纯国内" },
  { key: "share_prod_traditional", name: "传统贸易" },
  { key: "share_prod_simple_gvc", name: "简单 GVC" },
  { key: "share_prod_complex_gvc", name: "复杂 GVC" },
];

export function StackedShareViz({ rows }: { rows: Row[] }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const top = [...rows].sort((a, b) => num(b.share_prod_complex_gvc) - num(a.share_prod_complex_gvc)).slice(0, 15);
  const tipLines = (r: Row): [string, string][] => [
    ["", String(r.country)],
    ...PROD_SEGS.map((s) => [s.name, `${(num(r[s.key]) * 100).toFixed(1)}%`] as [string, string]),
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 16 }}>
        <Legend items={PROD_SEGS.map((s, i) => ({ name: s.name, color: CAT[i] }))} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {top.map((r) => (
          <div key={String(r.country)} style={{ display: "flex", alignItems: "center", gap: 12 }}
            onMouseEnter={(e) => show(e, tipLines(r))}
            onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
            <div style={{ width: 44, fontSize: 12, fontWeight: 500, textAlign: "right" }}>{String(r.country)}</div>
            <div style={{ flex: 1, display: "flex", height: 18, gap: 2 }}>
              {PROD_SEGS.map((s, i) => (
                <div key={s.key} style={{
                  width: `${num(r[s.key]) * 100}%`, background: CAT[i],
                  borderRadius: i === PROD_SEGS.length - 1 ? "0 4px 4px 0" : 0,
                }} />
              ))}
            </div>
            <div style={{ width: 86, fontSize: 11.5, color: "#8a90a0", fontVariantNumeric: "tabular-nums" }}>
              复杂 {(num(r.share_prod_complex_gvc) * 100).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 11, color: "#a2a8b6" }}>
        按 WWYZ 复杂 GVC 份额排序的 Top 15;条内四段加总 = 该国增加值的 100%
      </div>
      {Tip}
    </div>
  );
}

/* ---------------------------- 步骤10:长度双段条 ---------------------------- */

export function LengthViz({ rows }: { rows: Row[] }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const top = [...rows].sort((a, b) => num(b.upstreamness) - num(a.upstreamness)).slice(0, 15);
  const maxLen = Math.max(...top.map((r) => num(r.upstreamness)), 1);
  const ticks = Array.from({ length: Math.floor(maxLen) + 1 }, (_, i) => i);
  const tipLines = (r: Row): [string, string][] => [
    ["", String(r.country)],
    ["生产链长度", num(r.upstreamness).toFixed(2)],
    ["国内段", num(r.upstreamness_domestic).toFixed(2)],
    ["跨境段", num(r.upstreamness_cross).toFixed(2)],
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 16 }}>
        <Legend items={[{ name: "国内生产段", color: CAT[0] }, { name: "跨境生产段", color: CAT[1] }]} />
      </div>
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, left: 56, right: 56, pointerEvents: "none" }}>
          {ticks.map((t) => (
            <div key={t} style={{
              position: "absolute", top: 0, bottom: 0, left: `${(t / maxLen) * 100}%`,
              borderLeft: "1px solid #f0f1f6",
            }} />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 11, position: "relative" }}>
          {top.map((r) => (
            <div key={String(r.country)} style={{ display: "flex", alignItems: "center", gap: 12 }}
              onMouseEnter={(e) => show(e, tipLines(r))}
              onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
              <div style={{ width: 44, fontSize: 12, fontWeight: 500, textAlign: "right" }}>{String(r.country)}</div>
              <div style={{ flex: 1, display: "flex", height: 16, gap: 2 }}>
                <div style={{ width: `${(num(r.upstreamness_domestic) / maxLen) * 100}%`, background: CAT[0] }} />
                <div style={{
                  width: `${(num(r.upstreamness_cross) / maxLen) * 100}%`, background: CAT[1],
                  borderRadius: "0 4px 4px 0",
                }} />
              </div>
              <div style={{ width: 44, fontSize: 12.5, fontWeight: 600, color: "#3a4050", fontVariantNumeric: "tabular-nums" }}>
                {num(r.upstreamness).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
        <div style={{ position: "relative", height: 18, marginTop: 6, marginLeft: 56, marginRight: 56 }}>
          {ticks.map((t) => (
            <span key={t} style={{
              position: "absolute", left: `${(t / maxLen) * 100}%`, transform: "translateX(-50%)",
              fontSize: 10.5, color: "#b0b5c2", fontVariantNumeric: "tabular-nums",
            }}>{t}</span>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: "#a2a8b6" }}>
        按上游度排序的 Top 15;条形总长 = 生产链平均长度(一单位最终品经过的平均生产阶段数)
      </div>
      {Tip}
    </div>
  );
}

/* ----------------------------- 步骤11:热力表 ----------------------------- */

const HEAT_COLS = [
  { key: "degree_centrality", name: "度中心性" },
  { key: "betweenness_centrality", name: "介数中心性" },
  { key: "eigenvector_centrality", name: "特征向量中心性" },
];

export function HeatTableViz({ rows }: { rows: Row[] }) {
  const top = [...rows].sort((a, b) => num(b.betweenness_centrality) - num(a.betweenness_centrality)).slice(0, 15);
  const maxOf: Record<string, number> = {};
  HEAT_COLS.forEach((c) => { maxOf[c.key] = Math.max(...top.map((r) => num(r[c.key])), 1e-9); });
  const cell = (r: Row, key: string) => {
    const v = num(r[key]);
    const idx = Math.min(SEQ.length - 1, Math.floor((v / maxOf[key]) * SEQ.length));
    return (
      <div title={`${String(r.country)} · ${v.toFixed(4)}`} style={{
        width: 116, padding: "5px 0", borderRadius: 7, textAlign: "center",
        background: SEQ[idx], color: idx >= 3 ? "#fff" : "#1b1f2b",
        fontSize: 12, fontVariantNumeric: "tabular-nums",
      }}>{v.toFixed(3)}</div>
    );
  };
  return (
    <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "11px 18px", background: "#fafbfd", borderBottom: "1px solid #eef0f5", fontSize: 11.5, color: "#8a90a0", fontWeight: 600 }}>
        <div style={{ flex: 1 }}>国家 / 地区(按介数排序 Top 15)</div>
        {HEAT_COLS.map((c) => <div key={c.key} style={{ width: 150, textAlign: "center" }}>{c.name}</div>)}
      </div>
      {top.map((r) => (
        <div key={String(r.country)} style={{ display: "flex", alignItems: "center", padding: "6px 18px", borderBottom: "1px solid #f4f5f8", fontSize: 12.5 }}>
          <div style={{ flex: 1, fontWeight: 500 }}>{String(r.country)}</div>
          {HEAT_COLS.map((c) => (
            <div key={c.key} style={{ width: 150, display: "flex", justifyContent: "center" }}>{cell(r, c.key)}</div>
          ))}
        </div>
      ))}
      <div style={{ padding: "10px 18px", fontSize: 11, color: "#a2a8b6" }}>
        颜色深浅 = 该列内相对大小(每列独立归一化);数值为原始中心性
      </div>
    </div>
  );
}

/* ---------------- 步骤8-11 自由探索:排序条形图 / 散点图 ---------------- */

export function fmtVal(v: number, format?: string): string {
  if (format === "pct") return `${(v * 100).toFixed(1)}%`;
  if (format === "amount") return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  return v.toFixed(3);
}

/** 任意指标的排序条形图(学生自选指标 + 对象后驱动) */
export function RankBarChart({ rows, metricKey, label, format, highlight }: {
  rows: Row[]; metricKey: string; label: string; format?: string; highlight?: Set<string>;
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const data = [...rows].sort((a, b) => num(b[metricKey]) - num(a[metricKey]));
  const max = Math.max(...data.map((r) => num(r[metricKey])), 1e-9);
  return (
    <div style={cardStyle} ref={wrapRef}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>{label} · 排序</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {data.map((r) => {
          const v = num(r[metricKey]);
          const w = Math.max(1, (v / max) * 100);
          const entity = rowName(r);
          const hi = highlight?.has(entity);
          return (
            <div key={entity} style={{ display: "flex", alignItems: "center", gap: 10 }}
              onMouseMove={(e) => show(e, [["", entity], [label, fmtVal(v, format)]])}
              onMouseLeave={hide}>
              <span style={{ width: 58, fontSize: 11.5, color: "#5a6070", fontFamily: "monospace" }}>{entity}</span>
              <div style={{ flex: 1, height: 16, background: "#f2f3f7", borderRadius: 5, overflow: "hidden" }}>
                <div style={{ width: `${w}%`, height: "100%", background: hi ? CAT[5] : CAT[0], transition: "width .4s" }} />
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
  const pts = rows.map((r) => ({ c: rowName(r), x: num(r[xKey]), y: num(r[yKey]) }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const spread = (arr: number[]) => {
    const lo = Math.min(...arr), hi = Math.max(...arr), pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1;
    return [lo - pad, hi + pad] as const;
  };
  const [x0, x1] = spread(xs), [y0, y1] = spread(ys);
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
            <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize="10.5" fill="#8a90a0">{fmtVal(t, yFormat)}</text>
          </g>
        ))}
        {ticks(x0, x1).map((t, i) => (
          <text key={`x${i}`} x={px(t)} y={H - m.b + 18} textAnchor="middle" fontSize="10.5" fill="#8a90a0">{fmtVal(t, xFormat)}</text>
        ))}
        {/* 轴标题 */}
        <text x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle" fontSize="11.5" fill="#5a6070">{xLabel}</text>
        <text x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" fontSize="11.5" fill="#5a6070"
          transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{yLabel}</text>
        {/* 点 */}
        {pts.map((p) => {
          const hi = highlight?.has(p.c);
          return (
            <g key={p.c}
              onMouseMove={(e) => show(e, [["", p.c], [xLabel, fmtVal(p.x, xFormat)], [yLabel, fmtVal(p.y, yFormat)]])}
              onMouseLeave={hide} style={{ cursor: "pointer" }}>
              <circle cx={px(p.x)} cy={py(p.y)} r={hi ? 6 : 4.5}
                fill={hi ? CAT[5] : CAT[0]} fillOpacity={hi ? 0.95 : 0.62}
                stroke="#fff" strokeWidth={1} />
              {(showLabels || hi) && (
                <text x={px(p.x) + 7} y={py(p.y) + 3.5} fontSize="10" fill={hi ? CAT[5] : "#8a90a0"}
                  fontWeight={hi ? 700 : 400}>{p.c}</text>
              )}
            </g>
          );
        })}
      </svg>
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
  const W = 660, H = 380, m = { l: 62, r: 92, t: 16, b: 38 };
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const px = (i: number) => m.l + (years.length === 1 ? 0.5 : i / (years.length - 1)) * (W - m.l - m.r);
  const py = (v: number) => H - m.b - ((v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const yticks = [0, 1, 2, 3, 4].map((i) => y0 + ((y1 - y0) / 4) * i);
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
                <text x={px(last.i) + 7} y={py(last.v) + 3.5} fontSize="10.5" fill={color} fontWeight={700}>{s.country}</text>
              )}
            </g>
          );
        })}
      </svg>
      {Tip}
    </div>
  );
}

/* --------------------------- 事件研究:系数时间轴 --------------------------- */

export function EventStudyChart({ coefs, notes }: {
  coefs: { name: string; coef: number; se: number }[];
  notes: string[];
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const pts = coefs.map((c) => ({ ...c, lo: c.coef - 1.96 * c.se, hi: c.coef + 1.96 * c.se }));
  const W = 640, H = 240, padL = 56, padR = 24, padT = 18, padB = 34;
  const ext = Math.max(...pts.map((p) => Math.max(Math.abs(p.lo), Math.abs(p.hi))), 1e-6) * 1.15;
  const x = (i: number) => padL + ((i + 0.5) / pts.length) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v + ext) / (2 * ext)) * (H - padT - padB);
  const fmt = (v: number) => (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3));
  return (
    <div ref={wrapRef} style={{ ...cardStyle, marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050", marginBottom: 6 }}>
        事件研究:处理效应的动态路径(点 = 系数,须 = 95% 置信区间)
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }}>
        {[-ext, -ext / 2, ext / 2, ext].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#f0f1f6" strokeWidth={1} />
            <text x={padL - 8} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="#b0b5c2"
              fontFamily="inherit" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="#c3c6d1" strokeWidth={1} />
        <text x={padL - 8} y={y(0) + 3.5} textAnchor="end" fontSize={10} fill="#8a90a0">0</text>
        {pts.map((p, i) => (
          <g key={p.name}
            onMouseEnter={(e) => show(e, [
              ["", p.name],
              ["系数", fmt(p.coef)],
              ["95% CI", `[${fmt(p.lo)}, ${fmt(p.hi)}]`],
            ])}
            onMouseMove={(e) => show(e, [
              ["", p.name],
              ["系数", fmt(p.coef)],
              ["95% CI", `[${fmt(p.lo)}, ${fmt(p.hi)}]`],
            ])}
            onMouseLeave={hide} style={{ cursor: "default" }}>
            <rect x={x(i) - 14} y={padT} width={28} height={H - padT - padB} fill="transparent" />
            <line x1={x(i)} x2={x(i)} y1={y(p.lo)} y2={y(p.hi)} stroke={CAT[0]} strokeWidth={2} strokeLinecap="round" />
            <circle cx={x(i)} cy={y(p.coef)} r={5} fill={CAT[0]} stroke="#fff" strokeWidth={2} />
            <text x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize={11} fill="#5a6070"
              style={{ fontVariantNumeric: "tabular-nums" }}>{p.name}</text>
          </g>
        ))}
      </svg>
      <div style={{ marginTop: 6, fontSize: 11, color: "#a2a8b6" }}>
        {notes.find((n) => n.includes("基期")) ?? "基期为冲击前一年(系数归一为 0,不在图中)"}
      </div>
      {Tip}
    </div>
  );
}

/* --------------------- 步骤13-16:系数森林图(横向 CI) --------------------- */

/** 点=估计值,横条=95% 置信区间,竖线=0 轴;负效应红、正效应绿(与系数表一致)。 */
export function CoefForestChart({ coefs }: {
  coefs: { name: string; coef: number; se: number; p: number; stars: string }[];
}) {
  const { wrapRef, Tip, show, hide } = useTip();
  const pts = coefs.map((c) => ({ ...c, lo: c.coef - 1.96 * c.se, hi: c.coef + 1.96 * c.se }));
  const rowH = 40, padT = 14, padB = 30, labelW = 96, padR = 18;
  const W = 320, H = padT + pts.length * rowH + padB;
  const plotW = W - labelW - padR;
  const ext = Math.max(...pts.map((p) => Math.max(Math.abs(p.lo), Math.abs(p.hi))), 1e-6) * 1.12;
  const x = (v: number) => labelW + ((v + ext) / (2 * ext)) * plotW;
  const y = (i: number) => padT + (i + 0.5) * rowH;
  const fmt = (v: number) => (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3));
  const tip = (p: (typeof pts)[number]): [string, string][] => [
    ["", p.name],
    ["系数", `${fmt(p.coef)}${p.stars}`],
    ["95% CI", `[${fmt(p.lo)}, ${fmt(p.hi)}]`],
    ["p 值", p.p.toFixed(3)],
  ];
  return (
    <div ref={wrapRef} style={{ ...cardStyle, flex: "1 1 260px", minWidth: 260 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3a4050" }}>系数图</div>
      <div style={{ fontSize: 11, color: "#a2a8b6", marginBottom: 6 }}>点 = 估计值 · 横线 = 95% 置信区间</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }}>
        <line x1={x(0)} x2={x(0)} y1={padT} y2={H - padB} stroke="#e0e3ea" strokeWidth={1} />
        {[-ext, 0, ext].map((v) => (
          <text key={v} x={x(v)} y={H - padB + 16} textAnchor="middle" fontSize={10} fill="#b0b5c2"
            style={{ fontVariantNumeric: "tabular-nums" }}>{v === 0 ? "0" : fmt(v)}</text>
        ))}
        {pts.map((p, i) => {
          const neg = p.coef < 0;
          const dot = neg ? "#d1462f" : "#137a41";
          const ci = neg ? "#f0b3a4" : "#a9d9bc";
          return (
            <g key={p.name}
              onMouseEnter={(e) => show(e, tip(p))}
              onMouseMove={(e) => show(e, tip(p))}
              onMouseLeave={hide} style={{ cursor: "default" }}>
              <rect x={labelW} y={y(i) - rowH / 2} width={plotW} height={rowH} fill="transparent" />
              <text x={labelW - 8} y={y(i) + 3.5} textAnchor="end" fontSize={10.5} fill="#5a6070">
                {p.name.length > 13 ? `${p.name.slice(0, 12)}…` : p.name}
              </text>
              <line x1={x(p.lo)} x2={x(p.hi)} y1={y(i)} y2={y(i)} stroke={ci} strokeWidth={4} strokeLinecap="round" />
              <circle cx={x(p.coef)} cy={y(i)} r={5.5} fill={dot} stroke="#fff" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      {Tip}
    </div>
  );
}
