import { useId, useMemo, useState } from "react";
import { formatMetric } from "../../format";
import type { NetworkData } from "../../types";
import { CAT, Legend, REGION_OF, REGIONS, SEQ, cardStyle, countryLabel, num, useTip } from "../shared";

/* ------------------------------ 步骤10:网络图 ------------------------------ */

type NetworkMetric = "gvc_production_share" | "weighted degree" | "gross_exports";
type NetworkColorMode = "region" | NetworkMetric;

const NETWORK_METRICS: { key: NetworkMetric; label: string; format: "pct" | "number" | "amount" }[] = [
  { key: "gvc_production_share", label: "GVC 生产份额", format: "pct" },
  { key: "weighted degree", label: "双向贸易加权度", format: "amount" },
  { key: "gross_exports", label: "毛出口(百万美元)", format: "amount" },
];

function fmtNetworkMetric(value: number, format: "pct" | "number" | "amount") {
  return formatMetric(value, format);
}

function seqColor(value: number, max: number) {
  const idx = Math.min(SEQ.length - 1, Math.floor((value / Math.max(max, 1e-9)) * SEQ.length));
  return SEQ[idx];
}

export function NetworkViz({ data }: { data: NetworkData }) {
  const markerId = `network-edge-arrow-${useId().replaceAll(":", "")}`;
  const { wrapRef, Tip, show, hide } = useTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sizeMetric, setSizeMetric] = useState<NetworkMetric>("gvc_production_share");
  const [colorMode, setColorMode] = useState<NetworkColorMode>("region");
  const [edgeThreshold, setEdgeThreshold] = useState(0);
  const [onlySelectedEdges, setOnlySelectedEdges] = useState(false);

  const model = useMemo(() => {
    const W = 1000, H = 560, cx = W / 2, cy = H / 2;
    const byRegion: string[][] = REGIONS.map(() => []);
    const metrics: Record<NetworkMetric, Record<string, number>> = {
      gvc_production_share: {},
      "weighted degree": {},
      gross_exports: {},
    };
    data.nodes.forEach((n) => {
      const c = String(n.country);
      NETWORK_METRICS.forEach((m) => {
        metrics[m.key][c] = num(n[m.key]);
      });
      byRegion[REGION_OF[c] ?? 5].push(c);
    });
    byRegion.forEach((list) =>
      list.sort((a, b) => metrics.gvc_production_share[b] - metrics.gvc_production_share[a]));

    // 每个区域一个锚点,成员沿环排布;记录“朝外”单位向量供标签放射避让
    const pos: Record<string, { x: number; y: number; ox: number; oy: number }> = {};
    byRegion.forEach((list, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / REGIONS.length;
      const ax = cx + Math.cos(a) * 300, ay = cy + Math.sin(a) * 170;
      const ring = Math.min(108, 16 + list.length * 3.1);
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
      gvc_production_share: Math.max(...Object.values(metrics.gvc_production_share), 1e-9),
      "weighted degree": Math.max(...Object.values(metrics["weighted degree"]), 1e-9),
      gross_exports: Math.max(...Object.values(metrics.gross_exports), 1e-9),
    };
    // 伙伴只列一次，但分别保存流出/流入，不能把两条有向边误写成无方向的“双边流量”。
    const nbFlow: Record<string, Record<string, { inflow: number; outflow: number }>> = {};
    data.edges.forEach((e) => {
      const s = String(e.source), t = String(e.target), f = num(e.flow);
      const fromSource = (nbFlow[s] ??= {});
      const fromTarget = (nbFlow[t] ??= {});
      const sourcePartner = (fromSource[t] ??= { inflow: 0, outflow: 0 });
      const targetPartner = (fromTarget[s] ??= { inflow: 0, outflow: 0 });
      sourcePartner.outflow += f;
      targetPartner.inflow += f;
    });
    const neighbors: Record<string, { c: string; inflow: number; outflow: number; total: number }[]> = {};
    Object.entries(nbFlow).forEach(([c, m]) => {
      neighbors[c] = Object.entries(m)
        .map(([p, flow]) => ({ c: p, ...flow, total: flow.inflow + flow.outflow }))
        .sort((a, b) => b.total - a.total);
    });

    // 静态标签只给贸易流量最大的节点(区域内前 2),其余悬停时显示,避免密集区碰撞
    const flowSum: Record<string, number> = {};
    Object.entries(neighbors).forEach(([c, l]) => { flowSum[c] = l.reduce((s, n) => s + n.total, 0); });
    const topLabeled = new Set<string>();
    byRegion.forEach((list) =>
      [...list].sort((a, b) => (flowSum[b] ?? 0) - (flowSum[a] ?? 0)).slice(0, 2)
        .forEach((c) => topLabeled.add(c)));
    return { W, H, pos, metrics, maxMetric, maxFlow, neighbors, topLabeled };
  }, [data]);

  const { W, H, pos, metrics, maxMetric, maxFlow, neighbors, topLabeled } = model;
  const focus = hovered ?? selected;
  const adj = focus ? new Set([focus, ...(neighbors[focus] ?? []).map((n) => n.c)]) : null;
  const visibleEdges = data.edges.filter((e) => {
    const passesThreshold = num(e.flow) / maxFlow >= edgeThreshold;
    const touchesSelection = !onlySelectedEdges || !selected || String(e.source) === selected || String(e.target) === selected;
    return passesThreshold && touchesSelection;
  });
  const labeledEdges = new Set(selected
    ? visibleEdges.filter((edge) => String(edge.source) === selected || String(edge.target) === selected)
      .sort((a, b) => num(b.flow) - num(a.flow)).slice(0, 5)
    : []);
  const metricMeta = Object.fromEntries(NETWORK_METRICS.map((m) => [m.key, m])) as Record<NetworkMetric, typeof NETWORK_METRICS[number]>;
  const nodeRadius = (c: string) =>
    3.5 + ((metrics[sizeMetric][c] ?? 0) / Math.max(maxMetric[sizeMetric], 1e-9)) * 11;
  const nodeColor = (c: string) =>
    colorMode === "region"
      ? CAT[REGION_OF[c] ?? 5]
      : seqColor(metrics[colorMode][c] ?? 0, maxMetric[colorMode]);
  const tooltipLines = (c: string): [string, string][] => [
    ["", `${countryLabel(c)} · ${REGIONS[REGION_OF[c] ?? 5]}`],
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
        <label>显示边权阈值</label>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={edgeThreshold}
          onChange={(e) => setEdgeThreshold(Number(e.target.value))}
        />
        <b>{(edgeThreshold * 100).toFixed(0)}%</b>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="锁定节点后，仅保留与它直接相连的贸易边">
          <input type="checkbox" checked={onlySelectedEdges} onChange={(event) => setOnlySelectedEdges(event.target.checked)} />
          只看选中节点的边
        </label>
        {selected && <button onClick={() => setSelected(null)}>清除选择</button>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto" }} onClick={() => setSelected(null)}>
        <defs>
          <marker id={markerId} markerWidth="6" markerHeight="6" refX="5.2" refY="3"
            orient="auto" markerUnits="strokeWidth" viewBox="0 0 6 6">
            <path d="M0 0 L6 3 L0 6 Z" fill="context-stroke" />
          </marker>
        </defs>
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
            const controlX = mx - (dy / nl) * off;
            const controlY = my + (dx / nl) * off;
            const startLength = Math.hypot(controlX - p1.x, controlY - p1.y) || 1;
            const endLength = Math.hypot(p2.x - controlX, p2.y - controlY) || 1;
            const startGap = nodeRadius(s) + 2;
            const endGap = nodeRadius(t) + 4;
            const startX = p1.x + ((controlX - p1.x) / startLength) * startGap;
            const startY = p1.y + ((controlY - p1.y) / startLength) * startGap;
            const endX = p2.x - ((p2.x - controlX) / endLength) * endGap;
            const endY = p2.y - ((p2.y - controlY) / endLength) * endGap;
            const labelX = (startX + 2 * controlX + endX) / 4;
            const labelY = (startY + 2 * controlY + endY) / 4;
            const opacity = active ? 0.16 + f * 0.48 : 0.025;
            return (
              <g key={`${s}-${t}-${i}`}>
              <title>{s} → {t}: {fmtNetworkMetric(num(e.flow), "amount")} 百万美元</title>
              <path fill="none" stroke={col}
                d={`M${startX} ${startY} Q${controlX} ${controlY} ${endX} ${endY}`}
                opacity={opacity} markerEnd={`url(#${markerId})`}
                strokeWidth={0.7 + f * 3.8} strokeLinecap="round" />
              {labeledEdges.has(e) && (
                <text x={labelX} y={labelY - 4} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#3a4050"
                  stroke="#fff" strokeWidth={3.5} paintOrder="stroke" style={{ pointerEvents: "none" }}>
                  {s}→{t} · {fmtNetworkMetric(num(e.flow), "amount")}
                </text>
              )}
              </g>
            );
          })}
        </g>
        <g>
          {Object.keys(pos).map((c) => {
            const p = pos[c];
            const r = nodeRadius(c);
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
            <strong>{countryLabel(selected)}</strong>
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
            <thead><tr><th>伙伴</th><th>流出</th><th>流入</th><th>合计</th></tr></thead>
            <tbody>
              {selectedNeighbors.slice(0, 8).map((n) => (
                <tr key={n.c}>
                  <td>{countryLabel(n.c)}</td>
                  <td>{fmtNetworkMetric(n.outflow, "amount")}</td>
                  <td>{fmtNetworkMetric(n.inflow, "amount")}</td>
                  <td>{fmtNetworkMetric(n.total, "amount")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ position: "absolute", right: 18, bottom: 14, fontSize: 10.5, color: "#b0b5c2", textAlign: "right", lineHeight: 1.6 }}>
        节点大小 = {metricMeta[sizeMetric].label} · 节点颜色 = {colorMode === "region" ? "区域" : metricMeta[colorMode].label}<br />
        显示 {visibleEdges.length}/{data.edges.length} 条 Top 边；箭头表示 source → target<br />
        阈值仅影响 Top 边显示，不影响 Gephi 指标计算
      </div>
      {Tip}
    </div>
  );
}
