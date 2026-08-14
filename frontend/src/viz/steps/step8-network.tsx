import { useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LabeledControl, useDialogFocus } from "../../a11y";
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

/** Inline activation always opens the dialog; activation inside it only changes selection. */
export function networkNodeActivation(selected: string | null, country: string, expanded: boolean) {
  return {
    selected: expanded && selected === country ? null : country,
    expanded: true,
  };
}

/** Roving-tabindex navigation keeps a dense country graph to one Tab stop. */
export function nextNetworkNode(
  nodes: readonly string[],
  current: string,
  key: string,
): string | null {
  if (!nodes.length) return null;
  const currentIndex = Math.max(0, nodes.indexOf(current));
  if (key === "Home") return nodes[0];
  if (key === "End") return nodes.at(-1) ?? null;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return nodes[(currentIndex + 1) % nodes.length];
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return nodes[(currentIndex - 1 + nodes.length) % nodes.length];
  }
  return null;
}

function NetworkDialogFocus({
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onClose,
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | SVGElement | null>;
  returnFocusRef: RefObject<HTMLElement | SVGElement | null>;
  onClose: () => void;
}) {
  useDialogFocus({ containerRef, initialFocusRef, returnFocusRef, onClose });
  return null;
}

export function NetworkViz({
  data,
  onInspectCountry,
}: {
  data: NetworkData;
  /** 节点被选中时调用；取消选中不调用。 */
  onInspectCountry?: (country: string) => void;
}) {
  const idBase = useId().replaceAll(":", "");
  const markerId = `network-edge-arrow-${idBase}`;
  const dialogTitleId = `network-dialog-title-${idBase}`;
  const dialogDescriptionId = `network-dialog-description-${idBase}`;
  const { wrapRef, Tip, show, hide } = useTip();
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sizeMetric, setSizeMetric] = useState<NetworkMetric>("gvc_production_share");
  const [colorMode, setColorMode] = useState<NetworkColorMode>("region");
  const [edgeThreshold, setEdgeThreshold] = useState(0);
  const [keyboardFocus, setKeyboardFocus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState<number | null>(null);
  const nodeRefs = useRef<Record<string, SVGGElement | null>>({});
  const returnFocusCountryRef = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | SVGElement | null>(null);
  const dialogInitialFocusRef = useRef<HTMLElement | SVGElement | null>(null);

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
  const visibleEdges = data.edges.filter((e) => num(e.flow) / maxFlow >= edgeThreshold);
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
  const nodeOrder = Object.keys(pos);
  const tabbableNode = keyboardFocus && pos[keyboardFocus]
    ? keyboardFocus
    : selected && pos[selected]
      ? selected
      : nodeOrder[0] ?? null;
  const closeExpanded = () => {
    hide();
    setHovered(null);
    setExpanded(false);
  };
  const activateNode = (country: string) => {
    setKeyboardFocus(country);
    hide();
    setHovered(null);
    if (!expanded) {
      setPlaceholderHeight(wrapRef.current?.getBoundingClientRect().height ?? null);
      returnFocusCountryRef.current = country;
      returnFocusRef.current = nodeRefs.current[country] ?? null;
    }
    const nextSelected = networkNodeActivation(selected, country, expanded).selected;
    setSelected(nextSelected);
    setExpanded(true);
    if (nextSelected) onInspectCountry?.(nextSelected);
  };
  const accessibleNodeLabel = (country: string) => [
    countryLabel(country),
    REGIONS[REGION_OF[country] ?? 5],
    ...NETWORK_METRICS.map((metric) =>
      `${metric.label} ${fmtNetworkMetric(metrics[metric.key][country] ?? 0, metric.format)}`),
    selected === country ? "已选中" : "未选中",
    expanded ? "当前处于大图模式" : "激活后进入大图模式",
  ].join("，");

  const card = (
    <div
      ref={wrapRef}
      className={`network-card${expanded ? " network-card--fullscreen" : ""}`}
      style={{ ...cardStyle, padding: 0, overflow: "hidden" }}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? "true" : undefined}
      aria-labelledby={expanded ? dialogTitleId : undefined}
      aria-describedby={expanded ? dialogDescriptionId : undefined}
      tabIndex={expanded ? -1 : undefined}
    >
      {expanded && (
        <>
          <h2 id={dialogTitleId} className="sr-only">贸易网络大图</h2>
          <p id={dialogDescriptionId} className="sr-only">
            已进入贸易网络大图模式。可继续选择节点，按 Escape 或“退出大图”返回步骤页面。
          </p>
          <button
            ref={(node) => { dialogInitialFocusRef.current = node; }}
            type="button"
            className="network-fullscreen-exit"
            onClick={closeExpanded}
          >
            退出大图
          </button>
        </>
      )}
      <div className="network-toolbar">
        <LabeledControl label="节点大小">
          {(id) => (
            <select id={id} value={sizeMetric} onChange={(e) => setSizeMetric(e.target.value as NetworkMetric)}>
              {NETWORK_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="节点颜色">
          {(id) => (
            <select id={id} value={colorMode} onChange={(e) => setColorMode(e.target.value as NetworkColorMode)}>
              <option value="region">区域</option>
              {NETWORK_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="显示边权阈值">
          {(id) => (
            <input
              id={id}
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={edgeThreshold}
              onChange={(e) => setEdgeThreshold(Number(e.target.value))}
            />
          )}
        </LabeledControl>
        <b>{(edgeThreshold * 100).toFixed(0)}%</b>
        {selected && <button onClick={() => setSelected(null)}>清除选择</button>}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", width: "100%", height: expanded ? "100%" : "auto" }}
        role="group"
        aria-label={expanded
          ? "贸易网络大图。按方向键浏览节点，按 Enter 或空格选择节点。"
          : "全球贸易网络图。激活任意节点进入大图模式；按方向键浏览节点。"}
        onClick={() => setSelected(null)}
      >
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
              <g
                key={c}
                ref={(node) => {
                  nodeRefs.current[c] = node;
                  if (returnFocusCountryRef.current === c) returnFocusRef.current = node;
                }}
                className="network-node"
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.18 : 1}
                role="button"
                tabIndex={tabbableNode === c ? 0 : -1}
                aria-label={accessibleNodeLabel(c)}
                aria-pressed={selected === c}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  activateNode(c);
                }}
                onFocus={() => {
                  setKeyboardFocus(c);
                  setHovered(c);
                }}
                onBlur={() => {
                  setHovered((current) => current === c ? null : current);
                  hide();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    activateNode(c);
                    return;
                  }
                  const next = nextNetworkNode(nodeOrder, c, event.key);
                  if (!next) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setKeyboardFocus(next);
                  nodeRefs.current[next]?.focus();
                }}
                onMouseEnter={(e) => {
                  setHovered(c);
                  show(e, tooltipLines(c));
                }}
                onMouseMove={(e) => hovered === c && show(e, tooltipLines(c))}
                onMouseLeave={() => { setHovered(null); hide(); }}>
                <circle
                  className="network-node-hit"
                  r={Math.max(12, r + 6)}
                  fill={col}
                  fillOpacity={selected === c ? 0.22 : 0.12}
                />
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
      <div className="network-legend">
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
            <button
              type="button"
              aria-label="关闭节点详情"
              title="关闭节点详情"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
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
      <div className="network-caption">
        {expanded ? "大图模式 · 按 Esc 或“退出大图”返回" : "点击任意节点进入大图模式"}<br />
        节点大小 = {metricMeta[sizeMetric].label} · 节点颜色 = {colorMode === "region" ? "区域" : metricMeta[colorMode].label}<br />
        显示 {visibleEdges.length}/{data.edges.length} 条 Top 边；箭头表示 source → target<br />
        阈值仅影响 Top 边显示，不影响 Gephi 指标计算
      </div>
      {Tip}
    </div>
  );

  if (!expanded) return card;
  return (
    <>
      <div
        className="network-fullscreen-placeholder"
        style={{ height: placeholderHeight ?? undefined }}
        aria-hidden="true"
      />
      {createPortal(
        <div className="network-fullscreen-scrim">
          {card}
          {/* Keep this after the card so its layout effect sees the newly attached portal ref. */}
          <NetworkDialogFocus
            containerRef={wrapRef}
            initialFocusRef={dialogInitialFocusRef}
            returnFocusRef={returnFocusRef}
            onClose={closeExpanded}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
