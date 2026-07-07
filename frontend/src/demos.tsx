/**
 * 步骤4-7 的交互式「计算方法演示」组件。
 *
 * DecompositionDemo(步骤4/5/6):用真实指标数据把总量拆成各分项,
 *   实时校验恒等式(加总 = 毛出口 / 总增加值 / 上游度),每项可 hover 看含义。
 *   恒等式口径与后端引擎一致:
 *     步骤4 毛出口 = DVAex + DVArt + DDC + FVA + FDC + taxsub
 *     步骤5 SVA = 1_VA_D + 2_VA_RT + 3a_VA_GVC_S + 3b_VA_GVC_C
 *     步骤6 PLv = PLv_D + PLv_RT + PLv_GVC
 * NetworkCentralityDemo(步骤7):在一个小网络上演示度/介数中心性怎么算出来。
 */
import { useMemo, useState } from "react";
import { api } from "./api";
import { useAsync } from "./labs";
import { sectorLabel } from "./viz";
import type { Meta, IndustryPage } from "./types";

type Row = Record<string, string | number | null>;

type Part = { key: string; label: string; color: string; desc: string };
type DecompCfg = {
  total: string;
  totalLabel: string;
  unit: "amount" | "number";
  parts: Part[];
  note?: (r: Row) => string;
};

const DECOMP: Record<number, DecompCfg> = {
  4: {
    total: "__gross_exports",
    totalLabel: "毛出口",
    unit: "amount",
    parts: [
      { key: "DVAex", label: "DVAex 国外吸收", color: "#4b47e0", desc: "国内增加值出口并被其他地区吸收。" },
      { key: "DVArt", label: "DVArt 返回国内", color: "#7a6bff", desc: "国内增加值出口后最终返回本国被吸收。" },
      { key: "DDC", label: "DDC 国内重复计算", color: "#b6b1f2", desc: "国内增加值在跨境往返中被重复统计的部分。" },
      { key: "FVA", label: "FVA 国外增加值", color: "#159a86", desc: "总出口中来自国外账户的增加值。" },
      { key: "FDC", label: "FDC 国外重复计算", color: "#e0982a", desc: "总出口中来自国外账户的纯重复计算部分。" },
      { key: "taxsub", label: "taxsub 产品税补贴", color: "#7b8794", desc: "产品税减补贴在出口中的归属部分。" },
    ],
    note: (r) =>
      `EXDVA = DVAex + DVArt = ${fmt(num(r.DVAex) + num(r.DVArt), "amount")}。`,
  },
  5: {
    total: "SVA",
    totalLabel: "SVA 总增加值",
    unit: "amount",
    parts: [
      { key: "1_VA_D", label: "1_VA_D 纯国内", color: "#4b47e0", desc: "国内生产和消费的增加值,不涉及跨境贸易。" },
      { key: "2_VA_RT", label: "2_VA_RT 传统贸易", color: "#159a86", desc: "体现在最终产品出口中的国内增加值。" },
      { key: "3a_VA_GVC_S", label: "3a_VA_GVC_S 简单GVC", color: "#e0982a", desc: "增加值仅跨境一次,没有通过第三国再出口或返回。" },
      { key: "3b_VA_GVC_C", label: "3b_VA_GVC_C 复杂GVC", color: "#f4693b", desc: "增加值跨境两次及以上,深度嵌入全球生产网络。" },
    ],
  },
  6: {
    total: "PLv",
    totalLabel: "PLv 前向总生产长度",
    unit: "number",
    parts: [
      { key: "PLv_D", label: "PLv_D 国内段", color: "#4b47e0", desc: "前向生产链在本国境内平均经过的阶段数。" },
      { key: "PLv_RT", label: "PLv_RT 传统贸易段", color: "#159a86", desc: "前向生产链中传统贸易相关阶段数。" },
      { key: "PLv_GVC", label: "PLv_GVC GVC段", color: "#f4693b", desc: "前向生产链中 GVC 相关阶段数。" },
    ],
  },
};

function num(v: string | number | null | undefined): number {
  return typeof v === "number" ? v : 0;
}
function fmt(v: number, unit: "amount" | "number"): string {
  return unit === "amount"
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toFixed(3);
}
function totalOf(r: Row, cfg: DecompCfg): number {
  return cfg.total === "__gross_exports"
    ? cfg.parts.reduce((a, p) => a + num(r[p.key]), 0)
    : num(r[cfg.total]);
}

export function DecompositionDemo({ step, meta }: { step: number; meta: Meta }) {
  const cfg = DECOMP[step];
  const [gran, setGran] = useState<"country" | "industry">("industry");
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState("CHN");
  const [industry, setIndustry] = useState<string>("");
  const [hover, setHover] = useState<string | null>(null);

  const { data: countryRows } = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const { data: industryPage } = useAsync<IndustryPage>(
    () => api.industryIndicatorsAll(year, country),
    [year, country],
  );

  const industries = useMemo(
    () => (industryPage?.rows ?? []).map((r) => String(r.industry)),
    [industryPage],
  );
  // 默认选第一个行业;换国家后若旧行业不存在则回退
  const effIndustry = gran === "industry" ? (industries.includes(industry) ? industry : industries[0] ?? "") : "";

  const row: Row | undefined =
    gran === "country"
      ? countryRows?.find((r) => r.country === country)
      : (industryPage?.rows ?? []).find((r) => r.industry === effIndustry);

  const total = row ? totalOf(row, cfg) : 0;
  const sum = row ? cfg.parts.reduce((a, p) => a + num(row[p.key]), 0) : 0;
  const err = Math.abs(sum - total);
  const rel = total ? err / Math.abs(total) : err;
  const ok = rel < 1e-6;
  // 有些行业(家庭雇佣、公共管理、供水等)在该经济体几乎无出口/产出,
  // 分解虽仍"闭合"但信息量低、比例也容易受极小分母影响——提示学生换一个活跃行业。
  const countryTotal = (industryPage?.rows ?? []).reduce((a, r) => a + Math.abs(totalOf(r, cfg)), 0);
  const negligible =
    gran === "industry" && row != null &&
    (total === 0 || (countryTotal > 0 && Math.abs(total) / countryTotal < 1e-4));
  const negligibleReason = total === 0
    ? `${cfg.totalLabel}=0`
    : `${cfg.totalLabel}占本国行业合计不足 0.01%`;

  return (
    <div className="demo-card">
      <div className="demo-title">🧮 动手拆解 · 看着分项加回总量</div>

      <div className="demo-controls">
        <div className="pill-group">
          <button className={gran === "industry" ? "on" : ""} onClick={() => setGran("industry")}>国家–行业级</button>
          <button className={gran === "country" ? "on" : ""} onClick={() => setGran("country")}>国家级</button>
        </div>
        <label>国家</label>
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {gran === "industry" && (
          <>
            <label>行业</label>
            <select value={effIndustry} onChange={(e) => setIndustry(e.target.value)}>
              {industries.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
            </select>
          </>
        )}
        <label>年份</label>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* 公式:总量 = 分项 + 分项 + … */}
      <div className="decomp-formula">
        <span className="df-total">{cfg.totalLabel}</span>
        <span className="df-eq">=</span>
        {cfg.parts.map((p, i) => (
          <span key={p.key}>
            {i > 0 && <span className="df-plus">+</span>}
            <span
              className={`df-term${hover === p.key ? " on" : ""}`}
              style={hover === p.key ? { color: p.color, borderColor: p.color } : undefined}
              onMouseEnter={() => setHover(p.key)}
              onMouseLeave={() => setHover(null)}
            >
              {p.label.split(" ")[0]}
            </span>
          </span>
        ))}
      </div>

      {!row ? (
        <div className="muted" style={{ padding: "18px 0" }}>加载中…</div>
      ) : (
        <>
          <div className="decomp-total-line">
            {cfg.totalLabel} = <b>{fmt(total, cfg.unit)}</b>
            {cfg.unit === "amount" && <span className="muted"> (百万美元)</span>}
          </div>

          <div className="decomp-bar">
            {cfg.parts.map((p) => {
              const v = num(row[p.key]);
              const w = total ? Math.max(0, (v / total) * 100) : 0;
              return (
                <div
                  key={p.key}
                  className={`decomp-seg${hover && hover !== p.key ? " dim" : ""}`}
                  style={{ width: `${w}%`, background: p.color }}
                  onMouseEnter={() => setHover(p.key)}
                  onMouseLeave={() => setHover(null)}
                  title={`${p.label} · ${fmt(v, cfg.unit)} · ${(w).toFixed(1)}%`}
                />
              );
            })}
          </div>

          <div className={`decomp-identity ${ok ? "ok" : "bad"}`}>
            {ok ? "✓" : "✗"} {cfg.parts.length} 项加总 = {fmt(sum, cfg.unit)} ·
            与 {cfg.totalLabel} {fmt(total, cfg.unit)} 的误差 {err.toExponential(1)}
            {ok ? "(恒等式成立)" : "(请核对口径)"}
          </div>

          {negligible && (
            <div className="decomp-hint">
              ⚠️ {country} · {sectorLabel(effIndustry)} 的{negligibleReason}——
              这类几乎无出口/产出的行业分解信息量低,换一个活跃行业(如制造业)更能看清口径。
            </div>
          )}

          <table className="decomp-table">
            <tbody>
              {cfg.parts.map((p) => {
                const v = num(row[p.key]);
                const share = total ? (v / total) * 100 : 0;
                return (
                  <tr
                    key={p.key}
                    className={hover === p.key ? "on" : ""}
                    onMouseEnter={() => setHover(p.key)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <td className="dt-name">
                      <span className="dt-swatch" style={{ background: p.color }} />
                      {p.label}
                    </td>
                    <td className="dt-val">{fmt(v, cfg.unit)}</td>
                    <td className="dt-share">{share.toFixed(1)}%</td>
                    <td className="dt-desc">{p.desc}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {cfg.note && <div className="decomp-note">📌 {cfg.note(row)}</div>}
        </>
      )}
    </div>
  );
}

/* ============================ 步骤7:网络中心性演示 ============================ */

type Node = { id: string; x: number; y: number; label: string };
const NET_NODES: Node[] = [
  { id: "USA", x: 95, y: 85, label: "美" },
  { id: "MEX", x: 95, y: 235, label: "墨" },
  { id: "DEU", x: 255, y: 160, label: "德" },
  { id: "CHN", x: 415, y: 80, label: "中" },
  { id: "JPN", x: 415, y: 235, label: "日" },
  { id: "KOR", x: 545, y: 150, label: "韩" },
  { id: "VNM", x: 545, y: 290, label: "越" },
];
const NET_EDGES: [string, string][] = [
  ["USA", "DEU"], ["MEX", "DEU"], ["USA", "MEX"],
  ["DEU", "CHN"], ["DEU", "JPN"],
  ["CHN", "KOR"], ["JPN", "KOR"], ["JPN", "VNM"], ["KOR", "VNM"],
];

const ekey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function computeCentrality() {
  const ids = NET_NODES.map((n) => n.id);
  const adj: Record<string, string[]> = {};
  ids.forEach((i) => (adj[i] = []));
  NET_EDGES.forEach(([a, b]) => { adj[a].push(b); adj[b].push(a); });

  // 每个源点 BFS:dist、sigma(最短路条数)、preds
  const dist: Record<string, Record<string, number>> = {};
  const sigma: Record<string, Record<string, number>> = {};
  const preds: Record<string, Record<string, string[]>> = {};
  ids.forEach((s) => {
    const d: Record<string, number> = {}, sg: Record<string, number> = {}, pr: Record<string, string[]> = {};
    ids.forEach((i) => { d[i] = Infinity; sg[i] = 0; pr[i] = []; });
    d[s] = 0; sg[s] = 1;
    const q = [s];
    while (q.length) {
      const v = q.shift()!;
      for (const w of adj[v]) {
        if (d[w] === Infinity) { d[w] = d[v] + 1; q.push(w); }
        if (d[w] === d[v] + 1) { sg[w] += sg[v]; pr[w].push(v); }
      }
    }
    dist[s] = d; sigma[s] = sg; preds[s] = pr;
  });

  // Brandes 累积介数中心性(无向,最后除以 2)
  const bet: Record<string, number> = {};
  ids.forEach((i) => (bet[i] = 0));
  ids.forEach((s) => {
    const stack: string[] = [];
    const order = ids
      .filter((i) => dist[s][i] < Infinity)
      .sort((a, b) => dist[s][a] - dist[s][b]);
    order.forEach((v) => stack.push(v));
    const delta: Record<string, number> = {};
    ids.forEach((i) => (delta[i] = 0));
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of preds[s][w]) {
        delta[v] += (sigma[s][v] / sigma[s][w]) * (1 + delta[w]);
      }
      if (w !== s) bet[w] += delta[w];
    }
  });
  const n = ids.length;
  const deg: Record<string, number> = {};
  ids.forEach((i) => (deg[i] = adj[i].length));
  const norm = ((n - 1) * (n - 2)) / 2; // 无向归一化
  const betNorm: Record<string, number> = {};
  ids.forEach((i) => (betNorm[i] = norm ? bet[i] / 2 / norm : 0));
  const degNorm: Record<string, number> = {};
  ids.forEach((i) => (degNorm[i] = deg[i] / (n - 1)));

  return { adj, dist, sigma, preds, deg, degNorm, betNorm };
}

// 重建一条经过 v 的、跨度尽量大的最短路径,用于高亮演示
function samplePathThrough(v: string, C: ReturnType<typeof computeCentrality>): string[] {
  const ids = NET_NODES.map((n) => n.id);
  let best: string[] = [];
  let bestLen = -1;
  for (const s of ids) for (const t of ids) {
    if (s >= t || s === v || t === v) continue;
    if (C.dist[s][v] + C.dist[v][t] === C.dist[s][t] && C.dist[s][t] > bestLen) {
      // 沿 preds 从 t 回溯一条经过 v 的最短路径
      const half = (from: string, to: string): string[] | null => {
        // 回溯 to<-…<-from 的一条最短路径
        const path: string[] = [to];
        let cur = to;
        while (cur !== from) {
          const p = C.preds[from][cur][0];
          if (p === undefined) return null;
          path.push(p); cur = p;
        }
        return path.reverse();
      };
      const p1 = half(s, v), p2 = half(v, t);
      if (p1 && p2) { best = [...p1, ...p2.slice(1)]; bestLen = C.dist[s][t]; }
    }
  }
  return best;
}

export function NetworkCentralityDemo() {
  const C = useMemo(computeCentrality, []);
  const [mode, setMode] = useState<"degree" | "betweenness">("degree");
  const [sel, setSel] = useState<string>("DEU");

  const pathNodes = mode === "betweenness" ? samplePathThrough(sel, C) : [];
  const pathEdges = new Set<string>();
  for (let i = 0; i + 1 < pathNodes.length; i++) pathEdges.add(ekey(pathNodes[i], pathNodes[i + 1]));
  const neighbors = new Set(C.adj[sel]);

  const edgeActive = (a: string, b: string) =>
    mode === "degree"
      ? a === sel || b === sel
      : pathEdges.has(ekey(a, b));

  const selNode = NET_NODES.find((n) => n.id === sel)!;

  return (
    <div className="demo-card">
      <div className="demo-title">🕸️ 动手演示 · 中心性是怎么数出来的</div>
      <div className="demo-controls">
        <div className="pill-group">
          <button className={mode === "degree" ? "on" : ""} onClick={() => setMode("degree")}>度中心性</button>
          <button className={mode === "betweenness" ? "on" : ""} onClick={() => setMode("betweenness")}>介数中心性</button>
        </div>
        <span className="muted">点节点查看它的中心性</span>
      </div>

      <div className="net-demo-wrap">
        <svg viewBox="0 0 620 340" className="net-demo-svg">
          {NET_EDGES.map(([a, b]) => {
            const na = NET_NODES.find((n) => n.id === a)!;
            const nb = NET_NODES.find((n) => n.id === b)!;
            const active = edgeActive(a, b);
            return (
              <line
                key={ekey(a, b)} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                stroke={active ? "#4b47e0" : "#d8dbe6"}
                strokeWidth={active ? 3.5 : 1.5}
              />
            );
          })}
          {NET_NODES.map((n) => {
            const isSel = n.id === sel;
            const isNeighbor = mode === "degree" && neighbors.has(n.id);
            const onPath = mode === "betweenness" && pathNodes.includes(n.id);
            const val = mode === "degree" ? C.degNorm[n.id] : C.betNorm[n.id];
            const r = 18 + val * 20;
            return (
              <g key={n.id} onClick={() => setSel(n.id)} style={{ cursor: "pointer" }}>
                <circle
                  cx={n.x} cy={n.y} r={r}
                  fill={isSel ? "#4b47e0" : onPath ? "#7a6bff" : isNeighbor ? "#c9c4f7" : "#eef0f5"}
                  stroke={isSel ? "#2c2a6b" : "#c3c8d4"} strokeWidth={isSel ? 2.5 : 1}
                />
                <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="13" fontWeight="700"
                  fill={isSel || onPath ? "#fff" : "#3a4050"}>{n.label}</text>
              </g>
            );
          })}
        </svg>

        <div className="net-demo-panel">
          <div className="ndp-node">节点 <b>{selNode.label}</b>（{sel}）</div>
          {mode === "degree" ? (
            <>
              <div className="ndp-formula">度中心性 = 直接相连的节点数 / (N − 1)</div>
              <div className="ndp-calc">
                = {C.deg[sel]} / {NET_NODES.length - 1} = <b>{C.degNorm[sel].toFixed(3)}</b>
              </div>
              <p className="ndp-note">
                高亮的 {C.deg[sel]} 条连线就是它的直接连接。度中心性只看“邻居多不多”。
              </p>
            </>
          ) : (
            <>
              <div className="ndp-formula">介数中心性 = 经过它的最短路径占比(归一化)</div>
              <div className="ndp-calc">= <b>{C.betNorm[sel].toFixed(3)}</b></div>
              <p className="ndp-note">
                {pathNodes.length >= 3
                  ? <>例如 {pathNodes[0]} → {pathNodes[pathNodes.length - 1]} 的最短路要穿过 {sel}(已高亮)。越多这类“必经”对,介数越高——它是供应链的咽喉。</>
                  : <>{selNode.label} 很少落在别人的最短路径上,介数中心性低。</>}
              </p>
            </>
          )}
          <div className="ndp-disclaim">
            这是一个 7 节点的演示网络,用来展示算法本身。真实系统在 3465 个「国家×行业」节点的完整生产网络上计算(结果见步骤 11 的热力表)。
          </div>
        </div>
      </div>
    </div>
  );
}
