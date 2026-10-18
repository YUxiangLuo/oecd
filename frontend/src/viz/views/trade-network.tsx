import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LabeledControl, useDialogFocus } from "../../a11y";
import { formatMetric } from "../../format";
import { isolateFullscreenSiblings } from "../../fullscreen-panel";
import type { NetworkData } from "../../types";
import { CAT, Legend, REGION_OF, REGIONS, SEQ, cardStyle, countryLabel, num, useTip } from "../shared";

/* ------------------------------ 步骤9:网络图 ------------------------------ */

export type NetworkMetric = "gvc_production_share" | "weighted degree" | "gross_exports";
export type NetworkColorMode = "region" | NetworkMetric;
type NetworkEdge = NetworkData["edges"][number];
type NetworkMetricValue = number | null;

export interface NetworkNodeEncoding {
  eligible: boolean;
  radius: number;
  color: string;
}

export interface NetworkNodeEncodingModel {
  encodedMetrics: NetworkMetric[];
  nodes: Record<string, NetworkNodeEncoding>;
  sizeMax: number;
  colorMax: number | null;
}

const NETWORK_UNAVAILABLE_COLOR = "#7c828d";
const NETWORK_UNAVAILABLE_TEXT = "—（该指标不可用）";
export const DEFAULT_NETWORK_EDGE_THRESHOLD = 0.15;

export interface NetworkPartner {
  c: string;
  inflow: number;
  outflow: number;
  total: number;
}

export interface ThresholdedNetworkModel {
  publishedEdges: NetworkEdge[];
  visibleEdges: NetworkEdge[];
  neighbors: Record<string, NetworkPartner[]>;
  maxFlow: number;
  cutoff: number;
}

/** One thresholded edge contract shared by geometry, highlighting, hover and text details. */
export function thresholdedNetworkModel(
  edges: readonly NetworkEdge[],
  threshold: number,
): ThresholdedNetworkModel {
  const publishedEdges = edges.filter((edge) => {
    const flow = edge.flow;
    return typeof flow === "number" && Number.isFinite(flow) && flow > 0
      && String(edge.source ?? "") !== "" && String(edge.target ?? "") !== "";
  });
  const maxFlow = Math.max(...publishedEdges.map((edge) => edge.flow as number), 0);
  const normalizedThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  const cutoff = maxFlow * normalizedThreshold;
  const visibleEdges = publishedEdges.filter((edge) => (edge.flow as number) >= cutoff);
  const partnerFlows: Record<string, Record<string, { inflow: number; outflow: number }>> = {};
  visibleEdges.forEach((edge) => {
    const source = String(edge.source), target = String(edge.target), flow = edge.flow as number;
    const fromSource = (partnerFlows[source] ??= {});
    const fromTarget = (partnerFlows[target] ??= {});
    const sourcePartner = (fromSource[target] ??= { inflow: 0, outflow: 0 });
    const targetPartner = (fromTarget[source] ??= { inflow: 0, outflow: 0 });
    sourcePartner.outflow += flow;
    targetPartner.inflow += flow;
  });
  const neighbors: Record<string, NetworkPartner[]> = {};
  Object.entries(partnerFlows).forEach(([country, partners]) => {
    neighbors[country] = Object.entries(partners)
      .map(([partner, flow]) => ({ c: partner, ...flow, total: flow.inflow + flow.outflow }))
      .sort((first, second) => second.total - first.total || first.c.localeCompare(second.c));
  });
  return { publishedEdges, visibleEdges, neighbors, maxFlow, cutoff };
}

export function directedVisibleEdgeText(model: ThresholdedNetworkModel): string[] {
  return model.visibleEdges.map((edge) => `${String(edge.source)} → ${String(edge.target)}: ${String(edge.flow)}`);
}

const NETWORK_METRICS: { key: NetworkMetric; label: string; format: "pct" | "number" | "amount" }[] = [
  { key: "gvc_production_share", label: "GVC 生产份额", format: "pct" },
  { key: "weighted degree", label: "双向贸易加权度", format: "amount" },
  { key: "gross_exports", label: "总出口(百万美元)", format: "amount" },
];

function metricMetaLabel(metric: NetworkMetric): string {
  return NETWORK_METRICS.find(({ key }) => key === metric)?.label ?? metric;
}

function fmtNetworkMetric(value: number, format: "pct" | "number" | "amount") {
  return formatMetric(value, format);
}

/** Node metrics are quantitative only when the published value is a finite number. */
export function finiteNetworkMetric(value: string | number | null | undefined): NetworkMetricValue {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function networkMetricDisplay(
  value: string | number | null | undefined,
  format: "pct" | "number" | "amount",
): string {
  const finiteValue = finiteNetworkMetric(value);
  return finiteValue === null ? NETWORK_UNAVAILABLE_TEXT : fmtNetworkMetric(finiteValue, format);
}

export function networkThresholdAriaValueText(threshold: number): string {
  return `${(threshold * 100).toFixed(0)}%，相对最大边流量`;
}

function seqColor(value: number, max: number) {
  const idx = Math.min(SEQ.length - 1, Math.floor((value / Math.max(max, 1e-9)) * SEQ.length));
  return SEQ[idx];
}

/** Room left between two regions' rings: the largest node (radius 14.5) next to the largest click target (20.5). */
export const REGION_RING_GAP = 40;
/** Kept between a ring and the canvas edge, for the outermost node and its label. */
const REGION_CANVAS_MARGIN = 24;

/**
 * Pushes region anchors apart until no two rings come closer than REGION_RING_GAP, keeping every ring on the canvas.
 * On the default ellipse, Europe's 35-country ring and South/Southeast Asia's sit 170 apart with radii adding to
 * 164, so clicking KHM's centre selected IRL.
 */
export function separateRegionRings(anchors: { x: number; y: number; ring: number; used: boolean }[], width: number, height: number) {
  const clamp = (anchor: (typeof anchors)[number]) => {
    const margin = anchor.ring + REGION_CANVAS_MARGIN;
    anchor.x = Math.min(width - margin, Math.max(margin, anchor.x));
    anchor.y = Math.min(height - margin, Math.max(margin, anchor.y));
  };
  for (let pass = 0; pass < 50; pass++) {
    let moved = false;
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const first = anchors[i], second = anchors[j];
        if (!first.used || !second.used) continue;
        const dx = second.x - first.x, dy = second.y - first.y;
        const distance = Math.hypot(dx, dy) || 1e-6;
        const shortfall = first.ring + second.ring + REGION_RING_GAP - distance;
        if (shortfall <= 0.01) continue;
        const ux = dx / distance, uy = dy / distance, half = shortfall / 2 + 0.01;
        first.x -= ux * half; first.y -= uy * half;
        second.x += ux * half; second.y += uy * half;
        clamp(first); clamp(second);
        moved = true;
      }
    }
    if (!moved) return;
  }
}

/** Quantitative domains use only nodes that are finite for every currently encoded channel. */
export function networkNodeEncodingModel(
  nodes: readonly NetworkData["nodes"][number][],
  sizeMetric: NetworkMetric,
  colorMode: NetworkColorMode,
): NetworkNodeEncodingModel {
  const encodedMetrics: NetworkMetric[] = colorMode === "region" || colorMode === sizeMetric
    ? [sizeMetric]
    : [sizeMetric, colorMode];
  const values = nodes.map((node) => ({
    country: String(node.country),
    metrics: (Object.fromEntries(
      encodedMetrics.map((metric) => [metric, finiteNetworkMetric(node[metric])]),
    ) as Partial<Record<NetworkMetric, NetworkMetricValue>>),
  }));
  const eligible = values.filter(({ metrics }) =>
    encodedMetrics.every((metric) => metrics[metric] !== null));
  const eligibleMax = (metric: NetworkMetric) => Math.max(
    ...eligible.map(({ metrics }) => metrics[metric] as number),
    1e-9,
  );
  const sizeMax = eligibleMax(sizeMetric);
  const colorMax = colorMode === "region" ? null : eligibleMax(colorMode);
  const encodings: Record<string, NetworkNodeEncoding> = {};
  values.forEach(({ country, metrics }) => {
    const isEligible = encodedMetrics.every((metric) => metrics[metric] !== null);
    if (!isEligible) {
      encodings[country] = { eligible: false, radius: 3.5, color: NETWORK_UNAVAILABLE_COLOR };
      return;
    }
    const sizeValue = metrics[sizeMetric] as number;
    const color = colorMode === "region"
      ? CAT[REGION_OF[country] ?? 5]
      : seqColor(metrics[colorMode] as number, colorMax as number);
    encodings[country] = {
      eligible: true,
      radius: 3.5 + (sizeValue / Math.max(sizeMax, 1e-9)) * 11,
      color,
    };
  });
  return { encodedMetrics, nodes: encodings, sizeMax, colorMax };
}

/** Inline activation always opens the dialog; activation inside it only changes selection. */
export function networkNodeActivation(selected: string | null, country: string, expanded: boolean) {
  return {
    selected: expanded && selected === country ? null : country,
    expanded: true,
  };
}

/** Roving-focus navigation keeps a dense country graph to a single focus stop. */
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
  useEffect(() => {
    if (!containerRef.current) return undefined;
    return isolateFullscreenSiblings(containerRef.current);
  }, [containerRef]);
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
  const [edgeThreshold, setEdgeThreshold] = useState(DEFAULT_NETWORK_EDGE_THRESHOLD);
  const [keyboardFocus, setKeyboardFocus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState<number | null>(null);
  const nodeRefs = useRef<Record<string, SVGGElement | null>>({});
  const returnFocusCountryRef = useRef<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | SVGElement | null>(null);
  const dialogInitialFocusRef = useRef<HTMLElement | SVGElement | null>(null);
  const openingPointer = useRef<{ clientX: number; clientY: number } | null>(null);

  const model = useMemo(() => {
    const W = 1000, H = 560, cx = W / 2, cy = H / 2;
    const byRegion: string[][] = REGIONS.map(() => []);
    const metrics: Record<NetworkMetric, Record<string, NetworkMetricValue>> = {
      gvc_production_share: {},
      "weighted degree": {},
      gross_exports: {},
    };
    data.nodes.forEach((n) => {
      const c = String(n.country);
      NETWORK_METRICS.forEach((m) => {
        metrics[m.key][c] = finiteNetworkMetric(n[m.key]);
      });
      byRegion[REGION_OF[c] ?? 5].push(c);
    });
    byRegion.forEach((list) =>
      list.sort((a, b) =>
        (metrics.gvc_production_share[b] ?? Number.NEGATIVE_INFINITY)
        - (metrics.gvc_production_share[a] ?? Number.NEGATIVE_INFINITY)));

    // 每个区域一个锚点,成员沿环排布;记录“朝外”单位向量供标签放射避让
    const anchors = byRegion.map((list, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / REGIONS.length;
      const ring = list.length > 1 ? Math.min(108, 16 + list.length * 3.1) : 0;
      return { a, x: cx + Math.cos(a) * 300, y: cy + Math.sin(a) * 170, ring, used: list.length > 0 };
    });
    separateRegionRings(anchors, W, H);
    const pos: Record<string, { x: number; y: number; ox: number; oy: number }> = {};
    byRegion.forEach((list, i) => {
      const { a, x: ax, y: ay, ring } = anchors[i];
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

    return { W, H, pos, metrics, byRegion };
  }, [data]);
  const nodeEncodingModel = useMemo(
    () => networkNodeEncodingModel(data.nodes, sizeMetric, colorMode),
    [data.nodes, sizeMetric, colorMode],
  );
  const thresholdModel = useMemo(
    () => thresholdedNetworkModel(data.edges, edgeThreshold),
    [data.edges, edgeThreshold],
  );
  const fullModel = useMemo(() => thresholdedNetworkModel(data.edges, 0), [data.edges]);

  const { W, H, pos, metrics, byRegion } = model;
  const { visibleEdges, neighbors, maxFlow } = thresholdModel;
  // 静态标签只给当前可见贸易流量最大的节点(区域内前 2)。
  const flowSum: Record<string, number> = {};
  Object.entries(neighbors).forEach(([country, partners]) => {
    flowSum[country] = partners.reduce((sum, partner) => sum + partner.total, 0);
  });
  const topLabeled = new Set<string>();
  byRegion.forEach((list) =>
    [...list].sort((a, b) => (flowSum[b] ?? 0) - (flowSum[a] ?? 0)).slice(0, 2)
      .forEach((country) => topLabeled.add(country)));
  // A selected node owns both the highlighted links and the detail panel. Opening
  // the dialog may move another node under the pointer; that must not change focus.
  const focus = selected ?? hovered;
  const adj = focus ? new Set([focus, ...(neighbors[focus] ?? []).map((neighbor) => neighbor.c)]) : null;
  if (data.nodes.length === 0 && data.edges.length === 0) {
    return (
      <div style={cardStyle} role="status" aria-live="polite">
        <strong>贸易网络当前没有可显示的数据。</strong>
        <p className="muted">已成功加载空网络：0 个节点，0 条边。</p>
      </div>
    );
  }
  const hasSelectedMetrics = (country: string) => nodeEncodingModel.nodes[country]?.eligible ?? false;
  if (!Object.keys(pos).some(hasSelectedMetrics)) {
    const labels = nodeEncodingModel.encodedMetrics.map((metric) => metricMetaLabel(metric)).join("、");
    return (
      <div
        style={cardStyle}
        role="status"
        aria-live="polite"
        aria-label="贸易网络所选指标不可用"
      >
        <strong>贸易网络所选指标不可用。</strong>
        <p className="muted">数据已成功加载，但所有节点均缺少有限的{labels}值；未生成可操作网络图。</p>
      </div>
    );
  }
  const hasUnavailableContext = Object.keys(pos).some((country) => !hasSelectedMetrics(country));
  const metricMeta = Object.fromEntries(NETWORK_METRICS.map((m) => [m.key, m])) as Record<NetworkMetric, typeof NETWORK_METRICS[number]>;
  const nodeRadius = (country: string) => nodeEncodingModel.nodes[country]?.radius ?? 3.5;
  const nodeColor = (country: string) => nodeEncodingModel.nodes[country]?.color ?? NETWORK_UNAVAILABLE_COLOR;
  const tooltipLines = (c: string): [string, string][] => [
    ["", `${countryLabel(c)} · 预设地理区域：${REGIONS[REGION_OF[c] ?? 5]}`],
    ...NETWORK_METRICS.map((m) => [m.label, networkMetricDisplay(metrics[m.key][c], m.format)] as [string, string]),
    ["主要伙伴（完整贸易额）", (fullModel.neighbors[c] ?? []).slice(0, 4).map((n) => n.c).join("、") || "—"],
  ];
  const selectedNeighbors = selected ? fullModel.neighbors[selected] ?? [] : [];
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
  const activateNode = (country: string, pointer?: { clientX: number; clientY: number }) => {
    setKeyboardFocus(country);
    hide();
    setHovered(null);
    if (!expanded) {
      openingPointer.current = pointer ? { clientX: pointer.clientX, clientY: pointer.clientY } : null;
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
    `预设地理区域 ${REGIONS[REGION_OF[country] ?? 5]}`,
    ...NETWORK_METRICS.map((metric) =>
      `${metric.label} ${networkMetricDisplay(metrics[metric.key][country], metric.format)}`),
    selected === country ? "已选中" : "未选中",
    expanded ? "当前处于大图模式" : "激活后进入大图模式",
  ].join("，");

  const card = (
    <div
      ref={wrapRef}
      className={`network-card${expanded ? " network-card--fullscreen" : ""}`}
      style={{ ...cardStyle, padding: 0 }}
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
            已进入贸易网络大图模式。可继续选择节点，或使用“退出大图”返回步骤页面。
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
        <LabeledControl label="显示比例（相对最大边流量）">
          {(id) => (
            <input
              id={id}
              type="range"
              min={0}
              max={0.5}
              step={0.01}
              value={edgeThreshold}
              aria-valuetext={networkThresholdAriaValueText(edgeThreshold)}
              onChange={(e) => setEdgeThreshold(Number(e.target.value))}
            />
          )}
        </LabeledControl>
        <b>{(edgeThreshold * 100).toFixed(0)}%</b>
        <button
          type="button"
          onClick={() => setEdgeThreshold((current) => current === 0 ? DEFAULT_NETWORK_EDGE_THRESHOLD : 0)}
        >
          {edgeThreshold === 0 ? "恢复推荐 15%" : `显示全部 ${thresholdModel.publishedEdges.length} 条`}
        </button>
        {selected && <button onClick={() => setSelected(null)}>清除选择</button>}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", width: "100%", height: "auto" }}
        role="group"
        aria-label={expanded
          ? "贸易网络大图。节点位置采用预设地理区域布局，不是社区检测结果。"
          : "全球贸易网络图。节点位置采用预设地理区域布局，不是社区检测结果。"}
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
            const opacity = active ? 0.16 + f * 0.48 : 0.025;
            return (
              <g key={`${s}-${t}-${i}`}>
              <title>{`${s}(出口方) → ${t}(进口方): ${fmtNetworkMetric(num(e.flow), "amount")} 百万美元`}</title>
              <path fill="none" stroke={col}
                d={`M${startX} ${startY} Q${controlX} ${controlY} ${endX} ${endY}`}
                opacity={opacity} markerEnd={`url(#${markerId})`}
                strokeWidth={0.7 + f * 3.8} strokeLinecap="round" />
              </g>
            );
          })}
        </g>
        <g>
          {Object.keys(pos).map((c) => {
            const p = pos[c];
            const r = nodeRadius(c);
            const col = nodeColor(c);
            const unavailable = !hasSelectedMetrics(c);
            const dim = adj ? !adj.has(c) : false;
            const labeled = focus ? adj!.has(c) : topLabeled.has(c);
            return (
              <g
                key={c}
                ref={(node) => {
                  nodeRefs.current[c] = node;
                  if (returnFocusCountryRef.current === c) returnFocusRef.current = node;
                }}
                className={`network-node${unavailable ? " network-node--metric-unavailable" : ""}`}
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.18 : 1}
                role="button"
                tabIndex={tabbableNode === c ? 0 : -1}
                aria-label={accessibleNodeLabel(c)}
                aria-pressed={selected === c}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  activateNode(c, e);
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
                  if (openingPointer.current?.clientX === e.clientX && openingPointer.current.clientY === e.clientY) return;
                  openingPointer.current = null;
                  setHovered(c);
                  show(e, tooltipLines(c));
                }}
                onMouseMove={(e) => {
                  if (openingPointer.current?.clientX === e.clientX && openingPointer.current.clientY === e.clientY) return;
                  openingPointer.current = null;
                  setHovered(c);
                  show(e, tooltipLines(c));
                }}
                onMouseLeave={() => { setHovered(null); hide(); }}>
                <circle
                  className="network-node-hit"
                  r={Math.max(12, r + 6)}
                  fill={col}
                  fillOpacity={selected === c ? 0.22 : 0.12}
                />
                <circle
                  r={r}
                  fill={col}
                  stroke={unavailable ? "#343a46" : "#fff"}
                  strokeWidth={2}
                  strokeDasharray={unavailable ? "2.5 2" : undefined}
                />
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
      <details className="chart-data-disclosure network-edge-disclosure">
        <summary>查看当前显示的有向边文本表（{visibleEdges.length} 条）</summary>
        {visibleEdges.length === 0 ? (
          <p className="muted" role="status">当前阈值下没有可显示的贸易边。</p>
        ) : (
          <table className="data-table">
            <caption>当前阈值下绘制的有向边（伙伴详情使用完整贸易额）</caption>
            <thead><tr><th scope="col">源经济体</th><th scope="col">目标经济体</th><th scope="col">流量（百万美元）</th></tr></thead>
            <tbody>
              {visibleEdges.map((edge, index) => (
                <tr key={`${String(edge.source)}-${String(edge.target)}-${index}`}>
                  <th scope="row">{countryLabel(String(edge.source))}</th>
                  <td>{countryLabel(String(edge.target))}</td>
                  <td>{fmtNetworkMetric(edge.flow as number, "amount")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
      <div className="network-legend">
        <Legend items={[
          ...(colorMode === "region"
            ? REGIONS.map((r, i) => ({ name: r, color: CAT[i] }))
            : SEQ.map((color, i) => ({ name: i === 0 ? "低" : i === SEQ.length - 1 ? "高" : "", color })).filter((it) => it.name)),
          ...(hasUnavailableContext ? [{ name: "该指标不可用", color: NETWORK_UNAVAILABLE_COLOR }] : []),
        ]} />
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
                <b>{networkMetricDisplay(metrics[m.key][selected], m.format)}</b>
              </div>
            ))}
          </div>
          {selectedNeighbors.length === 0 ? (
            <p className="muted" role="status">该经济体没有正贸易流量的伙伴。</p>
          ) : (
            <table>
              <caption>按完整双向贸易额排列的前 8 个伙伴（百万美元）；† 表示该方向有贸易，但低于绘图阈值。</caption>
              <thead><tr><th>伙伴</th><th>流出（该国→伙伴）</th><th>流入（伙伴→该国）</th><th>合计</th></tr></thead>
              <tbody>
                {selectedNeighbors.slice(0, 8).map((n) => (
                  <tr key={n.c}>
                    <td>{countryLabel(n.c)}</td>
                    <td>{fmtNetworkMetric(n.outflow, "amount")}{n.outflow > 0 && n.outflow < thresholdModel.cutoff ? " †" : ""}</td>
                    <td>{fmtNetworkMetric(n.inflow, "amount")}{n.inflow > 0 && n.inflow < thresholdModel.cutoff ? " †" : ""}</td>
                    <td>{fmtNetworkMetric(n.total, "amount")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="network-caption">
        {expanded ? "大图模式 · 使用“退出大图”返回" : "推荐读图顺序：选一个国家 → 读主要流入/流出 → 再选第二个国家比较"}<br />
        节点位置 = 按预设地理区域摆放（不是算法聚类），便于比较区域内和区域间的流向<br />
        节点大小 = {metricMeta[sizeMetric].label} · 节点颜色 = {colorMode === "region" ? "预设地理区域" : metricMeta[colorMode].label}<br />
        {hasUnavailableContext && <>所选指标不可用节点 = 灰色虚线、固定最小尺寸（仅保留网络上下文）<br /></>}
        显示条件：边流量不低于最大边流量的 {(edgeThreshold * 100).toFixed(0)}%，当前显示 {visibleEdges.length}/{thresholdModel.publishedEdges.length} 条贸易边；默认 15% 只为读图清晰；箭头从出口方指向进口方<br />
        数据包含完整跨国贸易边；显示比例只影响画出哪些边和伙伴高亮，伙伴详情的贸易额与完整网络上的中心性不变
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
