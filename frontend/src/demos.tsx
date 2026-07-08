/**
 * 步骤4-7 的交互式「计算方法演示」组件。
 *
 * DecompositionDemo(步骤4/5/6):用真实指标数据把总量拆成各分项,
 *   实时校验恒等式(加总 = 毛出口 / 总增加值 / 总生产长度),每项可 hover 看含义。
 *   恒等式口径与后端引擎一致(客户资料口径):
 *     步骤4 毛出口 = DVAex + DVArt + DDC + FVA + FDC + taxsub(WWZ 总贸易核算)
 *     步骤5 SVA = 纯国内 + 传统贸易 + 简单GVC + 复杂GVC(WWYZ 2017a)
 *     步骤6 PLv = 各段长度按对应增加值份额的加权平均(WWYZ 2017b;
 *           分项显示为"VA份额×段长度"的贡献值,贡献加总 = 总长度)
 * NetworkCentralityDemo(步骤7):在一个小网络上演示度/介数中心性怎么算出来。
 */
import { useMemo, useState } from "react";
import { api } from "./api";
import { useAsync } from "./labs";
import { sectorLabel } from "./viz";
import type { IndustryPage, Meta } from "./types";

type Row = Record<string, string | number | null>;

type Part = {
  key: string;
  label: string;
  color: string;
  desc: string;
  /** 加权模式:分项贡献 = row[key] × row[weightKey] / row[weightTotal](见步骤6) */
  weightKey?: string;
};
type DecompCfg = {
  total: string;
  totalLabel: string;
  unit: "amount" | "number";
  parts: Part[];
  /** 加权模式的权重分母(如 SVA);设置后各分项按 VA 份额加权 */
  weightTotal?: string;
  note?: (r: Row) => string;
};

const DECOMP: Record<number, DecompCfg> = {
  4: {
    total: "gross_exports",
    totalLabel: "毛出口",
    unit: "amount",
    parts: [
      { key: "DVAex", label: "DVAex 国内增加值出口", color: "#4b47e0", desc: "出口中由本国创造、并被国外最终吸收的增加值。占比越高,出口越“实”。" },
      { key: "DVArt", label: "DVArt 返回国内", color: "#7a6bff", desc: "先随出口离境、绕一圈又回到本国被吸收的国内增加值。" },
      { key: "DDC", label: "DDC 国内重复计算", color: "#b6b1f2", desc: "本国增加值在跨境往返中被海关多次统计的部分。" },
      { key: "FVA", label: "FVA 外国增加值", color: "#159a86", desc: "出口里来自外国的增加值(进口的中间品)。后向 GVC 依赖的核心。" },
      { key: "FDC", label: "FDC 外国重复计算", color: "#e0982a", desc: "外国增加值在跨境中被重复统计的部分。" },
      { key: "taxsub", label: "taxsub 税收减补贴", color: "#98a0b3", desc: "毛出口中的产品税减补贴(TLS)含量,来自 ICIO 原始表的 TLS 账户行。" },
    ],
    note: (r) =>
      `EXDVA 出口国内增加值合计 = DVAex + DVArt = ${fmt(num(r.DVAex) + num(r.DVArt), "amount")}` +
      `(WWZ 2013 / 王直等 2015 总贸易核算法,16 项分解归组为上面六大类)。`,
  },
  5: {
    total: "SVA",
    totalLabel: "总增加值 SVA",
    unit: "amount",
    parts: [
      { key: "1_VA_D", label: "1_VA_D 纯国内生产", color: "#4b47e0", desc: "增加值只服务本国最终需求,完全不跨境。" },
      { key: "2_VA_RT", label: "2_VA_RT 传统贸易生产", color: "#159a86", desc: "增加值随最终产品直接出口,货物只过一次国境。" },
      { key: "3a_VA_GVC_S", label: "3a 简单 GVC 生产", color: "#e0982a", desc: "增加值随中间品跨境一次后在国外被吸收。" },
      { key: "3b_VA_GVC_C", label: "3b 复杂 GVC 生产", color: "#f4693b", desc: "增加值至少两次跨越国境,深度嵌入全球生产网络。对政策冲击最敏感。" },
    ],
    note: (r) =>
      `3_VA_GVC = 3a + 3b = ${fmt(num(r["3a_VA_GVC_S"]) + num(r["3b_VA_GVC_C"]), "amount")};` +
      `另有对称的后向分解 FGY 系列(按最终产品完成地记账),见上方指标表。`,
  },
  6: {
    total: "PLv",
    totalLabel: "前向总生产长度 PLv",
    unit: "number",
    weightTotal: "SVA",
    parts: [
      { key: "PLv_D", label: "纯国内段长度", color: "#4b47e0", desc: "纯国内生产活动的平均长度,按 1_VA_D/SVA 份额加权计入总长度。", weightKey: "1_VA_D" },
      { key: "PLv_RT", label: "传统贸易段长度", color: "#159a86", desc: "传统贸易生产活动的平均长度,按 2_VA_RT/SVA 份额加权计入。", weightKey: "2_VA_RT" },
      { key: "PLv_GVC", label: "GVC 段长度", color: "#f4693b", desc: "GVC 生产活动的平均长度(通常最长,增加值多次被计为产出),按 3_VA_GVC/SVA 份额加权计入。", weightKey: "3_VA_GVC" },
    ],
    note: (r) =>
      `各分项显示的是"VA 份额 × 段长度"的贡献值(WWYZ 2017b:总长度是段长度的增加值加权平均);` +
      `段长度本身:PLv_D=${num(r.PLv_D).toFixed(2)}、PLv_RT=${num(r.PLv_RT).toFixed(2)}、PLv_GVC=${num(r.PLv_GVC).toFixed(2)};` +
      `GVC 位置指数 GVCPs = PLv_GVC / PLy_GVC = ${num(r.GVCPs).toFixed(3)}。`,
  },
};

function num(v: string | number | null | undefined): number {
  return typeof v === "number" ? v : 0;
}
function partValue(row: Row, p: Part, cfg: DecompCfg): number {
  if (!p.weightKey || !cfg.weightTotal) return num(row[p.key]);
  const wTot = num(row[cfg.weightTotal]);
  return wTot ? (num(row[p.weightKey]) * num(row[p.key])) / wTot : 0;
}
function fmt(v: number, unit: "amount" | "number"): string {
  return unit === "amount"
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toFixed(3);
}

export function DecompositionDemo({ step, meta }: { step: number; meta: Meta }) {
  const cfg = DECOMP[step];
  const [gran, setGran] = useState<"country" | "sector">("sector");
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState("CHN");
  const [sector, setSector] = useState<string>("");
  const [hover, setHover] = useState<string | null>(null);

  const { data: countryRows } = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const { data: sectorPage } = useAsync<IndustryPage>(
    () => api.industryIndicatorsAll(year, country),
    [year, country],
  );

  const sectors = useMemo(
    () => (sectorPage?.rows ?? []).map((r) => String(r.industry)),
    [sectorPage],
  );
  // 默认选第一个行业;换国家后若旧行业不存在则回退
  const effSector = gran === "sector" ? (sectors.includes(sector) ? sector : sectors[0] ?? "") : "";

  const row: Row | undefined =
    gran === "country"
      ? countryRows?.find((r) => r.country === country)
      : (sectorPage?.rows ?? []).find((r) => r.industry === effSector);

  const total = row ? num(row[cfg.total]) : 0;
  const sum = row ? cfg.parts.reduce((a, p) => a + partValue(row, p, cfg), 0) : 0;
  const err = Math.abs(sum - total);
  const rel = total ? err / Math.abs(total) : err;
  const ok = rel < 1e-6;
  // 有些行业(家庭雇佣、公共管理、供水等)在该经济体几乎无出口/产出,
  // 分解虽仍"闭合"但信息量低、比例也容易受极小分母影响——提示学生换一个活跃行业。
  const countryTotal = (sectorPage?.rows ?? []).reduce((a, r) => a + Math.abs(num(r[cfg.total])), 0);
  const negligible =
    gran === "sector" && row != null &&
    (total === 0 || (countryTotal > 0 && Math.abs(total) / countryTotal < 1e-4));
  const negligibleReason = total === 0
    ? `${cfg.totalLabel}=0`
    : `${cfg.totalLabel}占本国行业合计不足 0.01%`;

  return (
    <div className="demo-card">
      <div className="demo-title">🧮 动手拆解 · 看着分项加回总量</div>

      <div className="demo-controls">
        <div className="pill-group">
          <button className={gran === "sector" ? "on" : ""} onClick={() => setGran("sector")}>国家–行业级</button>
          <button className={gran === "country" ? "on" : ""} onClick={() => setGran("country")}>国家级</button>
        </div>
        <label>国家</label>
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {gran === "sector" && (
          <>
            <label>行业</label>
            <select value={effSector} onChange={(e) => setSector(e.target.value)}>
              {sectors.map((s) => <option key={s} value={s}>{sectorLabel(s)}</option>)}
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
              const v = partValue(row, p, cfg);
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
              ⚠️ {country} · {sectorLabel(effSector)} 的{negligibleReason}——
              这类几乎无出口/产出的行业分解信息量低,换一个活跃行业(如制造业)更能看清口径。
            </div>
          )}

          <table className="decomp-table">
            <tbody>
              {cfg.parts.map((p) => {
                const v = partValue(row, p, cfg);
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
