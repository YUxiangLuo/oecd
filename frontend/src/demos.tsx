/**
 * 步骤3-6 的交互式「计算方法演示」组件。
 *
 * DecompositionDemo(步骤3/4/5):用真实指标数据把总量拆成各分项,
 *   实时校验恒等式(加总 = 毛出口 / 总增加值 / 总生产长度),每项可 hover 看含义。
 *   恒等式口径与后端引擎及公开文献一致:
 *     步骤3 毛出口 = DVAex + DVArt + DDC + FVA + FDC + taxsub(WWZ 总贸易核算)
 *     步骤4 SVA = 纯国内 + 传统贸易 + 简单GVC + 复杂GVC(WWYZ 2017a)
 *     步骤5 PLv = 各段长度按对应增加值份额的加权平均(WWYZ 2017b;
 *           分项显示为"VA份额×段长度"的贡献值,贡献加总 = 总长度)
 * NetworkCentralityDemo(步骤6):在一个小网络上演示度/介数中心性怎么算出来。
 */
import { useEffect, useMemo, useState } from "react";
import { LabeledControl } from "./a11y";
import { stripNegativeZero } from "./format";
import { api } from "./api";
import { useAsync } from "./labs";
import { countryLabel, sectorLabel } from "./viz";
import { signedDomain, signedStack } from "./viz/signed-layout";
import type { IndustryPage, Meta } from "./types";

type Row = Record<string, string | number | null>;

type Part = {
  key: string;
  label: string;
  color: string;
  desc: string;
  /** 加权模式:分项贡献 = row[key] × row[weightKey] / row[weightTotal](见步骤5) */
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
      { key: "DVAex", label: "DVAex 国内增加值出口", color: "#4b47e0", desc: "出口中由本国创造、并被国外最终吸收的增加值；占比越高表示这类国内增加值构成越高。" },
      { key: "DVArt", label: "DVArt 返回国内", color: "#7a6bff", desc: "先随出口离境、绕一圈又回到本国被吸收的国内增加值。" },
      { key: "DDC", label: "DDC 国内重复计算", color: "#b6b1f2", desc: "本国增加值在跨境往返中被海关多次统计的部分。" },
      { key: "FVA", label: "FVA 外国增加值", color: "#159a86", desc: "出口里来自外国的增加值(进口的中间品)。后向 GVC 依赖的核心。" },
      { key: "FDC", label: "FDC 外国重复计算", color: "#e0982a", desc: "外国增加值在跨境中被重复统计的部分。" },
      { key: "taxsub", label: "taxsub 税收减补贴", color: "#98a0b3", desc: "出口直接及间接所含的产品税减补贴(TLS)，由 ICIO TLS 账户沿投入产出链计算。" },
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
      { key: "3b_VA_GVC_C", label: "3b 复杂 GVC 生产", color: "#f4693b", desc: "增加值至少两次跨越国境并进入复杂跨境生产；是否对特定政策更敏感需另行检验。" },
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
  return stripNegativeZero(unit === "amount"
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toFixed(3));
}

const PLY_DECOMP: DecompCfg = {
  total: "PLy",
  totalLabel: "后向总生产长度 PLy",
  unit: "number",
  weightTotal: "FGY",
  parts: [
    { key: "PLy_D", label: "纯国内段", color: "#4b47e0", desc: "按 1_FGY_D / FGY 加权。", weightKey: "1_FGY_D" },
    { key: "PLy_RT", label: "传统贸易段", color: "#159a86", desc: "按 2_FGY_RT / FGY 加权。", weightKey: "2_FGY_RT" },
    { key: "PLy_GVC", label: "GVC 段", color: "#f4693b", desc: "按 3_FGY_GVC / FGY 加权。", weightKey: "3_FGY_GVC" },
  ],
};

function MiniBackwardBar({ row }: { row: Row }) {
  const values = PLY_DECOMP.parts.map((part) => partValue(row, part, PLY_DECOMP));
  const total = num(row.PLy);
  const sum = values.reduce((acc, value) => acc + value, 0);
  const layout = signedStack(values, signedDomain([values], true), true);
  return (
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "#f8f9fc" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11.5, marginBottom: 7 }}>
        <b>后向 PLy · 最终品回溯到初始投入端</b>
        <span>{fmt(total, "number")}</span>
      </div>
      <div style={{ position: "relative", height: 12, background: "#eceef4", borderRadius: 5, overflow: "hidden" }}>
        {PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} title={`${part.label}: ${fmt(values[index], "number")}`}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${layout.segments[index].leftPct}%`, width: `${layout.segments[index].widthPct}%`, background: layout.segments[index].negative ? "#e34948" : part.color }} />
        ))}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
        PLy = Σ(FGY 分项份额 × 对应段长度) = {fmt(sum, "number")}；与总量误差 {Math.abs(sum - total).toExponential(1)}。
        GVCPs = PLv_GVC / PLy_GVC = {num(row.GVCPs).toFixed(3)}。
      </div>
    </div>
  );
}

export function DecompositionDemo({
  step,
  meta,
  onExampleChange,
  primaryYear,
  primaryCountry,
  onPrimaryChange,
}: {
  step: number;
  meta: Meta;
  onExampleChange?: (year: number, country: string) => void;
  /** Keep the table and demo on the same primary entity. */
  primaryYear?: number;
  primaryCountry?: string;
  onPrimaryChange?: (year: number, country: string) => void;
}) {
  const cfg = DECOMP[step];
  const defaultA = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const defaultB = meta.countries.includes("USA") ? "USA" : meta.countries[1] ?? defaultA;
  const [gran, setGran] = useState<"country" | "sector">("sector");
  const [year, setYear] = useState(primaryYear ?? meta.years.at(-1)!);
  const [compare, setCompare] = useState(false);
  const [countryA, setCountryA] = useState(primaryCountry ?? defaultA);
  const [countryB, setCountryB] = useState(defaultB);
  const [sectorA, setSectorA] = useState("");
  const [sectorB, setSectorB] = useState("");
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (primaryYear != null) setYear(primaryYear);
  }, [primaryYear]);
  useEffect(() => {
    if (primaryCountry) setCountryA(primaryCountry);
  }, [primaryCountry]);

  const { data: countryRows } = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const { data: pageA } = useAsync<IndustryPage>(() => api.industryIndicatorsAll(year, countryA), [year, countryA]);
  const { data: pageB } = useAsync<IndustryPage | null>(
    () => compare ? api.industryIndicatorsAll(year, countryB) : Promise.resolve(null),
    [year, countryB, compare],
  );
  const exampleCountry = meta.countries.includes("BRN") ? "BRN" : meta.countries[0] ?? "";
  const exampleYear = meta.years.includes(2020) ? 2020 : meta.years.at(-1)!;
  const { data: examplePage, error: exampleError } = useAsync<IndustryPage | null>(
    () => step === 4 && exampleCountry ? api.industryIndicatorsAll(exampleYear, exampleCountry) : Promise.resolve(null),
    [step, exampleCountry, exampleYear],
  );
  const negativeExample = useMemo(() => [...(examplePage?.rows ?? [])]
    .filter((row) => {
      const total = num(row.gross_exports);
      return total > 1 && num(row.taxsub) < 0 && Math.abs(num(row.taxsub) / total) >= 0.001;
    })
    .sort((a, b) => Math.abs(num(b.taxsub) / num(b.gross_exports)) - Math.abs(num(a.taxsub) / num(a.gross_exports)))[0], [examplePage]);

  const sectorsA = (pageA?.rows ?? []).map((row) => String(row.industry));
  const sectorsB = (pageB?.rows ?? []).map((row) => String(row.industry));
  const effSectorA = sectorsA.includes(sectorA) ? sectorA : sectorsA[0] ?? "";
  const effSectorB = sectorsB.includes(sectorB) ? sectorB : sectorsB[0] ?? "";
  const rowA = gran === "country"
    ? countryRows?.find((row) => row.country === countryA)
    : pageA?.rows.find((row) => row.industry === effSectorA);
  const rowB = gran === "country"
    ? countryRows?.find((row) => row.country === countryB)
    : pageB?.rows.find((row) => row.industry === effSectorB);
  const panelRows = [rowA, ...(compare ? [rowB] : [])];
  const valuesByRow = panelRows.filter((row): row is Row => row != null)
    .map((row) => cfg.parts.map((part) => partValue(row, part, cfg)));
  const domain = signedDomain(valuesByRow, true);

  const entityPicker = (side: "A" | "B") => {
    const country = side === "A" ? countryA : countryB;
    const setCountry = side === "A" ? setCountryA : setCountryB;
    const sector = side === "A" ? effSectorA : effSectorB;
    const setSector = side === "A" ? setSectorA : setSectorB;
    const sectors = side === "A" ? sectorsA : sectorsB;
    return (
      <div className="demo-controls" style={{ marginBottom: 10 }}>
        <b>{compare ? `实体 ${side}` : "分析实体"}</b>
        <LabeledControl label="国家">
          {(id) => (
            <select id={id} value={country} onChange={(event) => {
              setCountry(event.target.value);
              if (side === "A") onPrimaryChange?.(year, event.target.value);
            }}>
              {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
            </select>
          )}
        </LabeledControl>
        {gran === "sector" && <>
          <LabeledControl label="行业">
            {(id) => (
              <select id={id} value={sector} onChange={(event) => setSector(event.target.value)}>
                {sectors.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
              </select>
            )}
          </LabeledControl>
        </>}
      </div>
    );
  };

  const panel = (row: Row | undefined, side: "A" | "B", page: IndustryPage | null, sector: string, country: string) => {
    if (!row) return <div className="muted" style={{ padding: 18 }}>加载实体 {side}…</div>;
    const values = cfg.parts.map((part) => partValue(row, part, cfg));
    const layout = signedStack(values, domain, true);
    const total = num(row[cfg.total]);
    const sum = values.reduce((acc, value) => acc + value, 0);
    const error = Math.abs(sum - total);
    const ok = (total ? error / Math.abs(total) : error) < 1e-6;
    const countryTotal = (page?.rows ?? []).reduce((acc, item) => acc + Math.abs(num(item[cfg.total])), 0);
    const negligible = gran === "sector" && (total === 0 || (countryTotal > 0 && Math.abs(total) / countryTotal < 1e-4));
    return (
      <div style={{ minWidth: 0 }}>
        {entityPicker(side)}
        <div className="decomp-total-line">
          {cfg.totalLabel} = <b>{fmt(total, cfg.unit)}</b>{cfg.unit === "amount" && <span className="muted"> (百万美元)</span>}
        </div>
        <div className="decomp-bar" style={{ position: "relative", display: "block", overflow: "hidden" }}>
          {domain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 3, left: `${layout.zeroPct}%`, top: -2, bottom: -2, borderLeft: "2px solid #4b5263" }} />}
          {cfg.parts.map((part, index) => {
            const value = values[index];
            const share = total ? (value / total) * 100 : 0;
            const segment = layout.segments[index];
            return <span key={part.key}
              className={`decomp-seg${hover && hover !== part.key ? " dim" : ""}`}
              style={{ position: "absolute", top: 0, bottom: 0, left: `${segment.leftPct}%`, width: `${segment.widthPct}%`, background: segment.negative ? "#e34948" : part.color }}
              onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}
              title={`${part.label} · 真实值 ${fmt(value, cfg.unit)} · 有符号占比 ${share.toFixed(1)}%${segment.negative ? "（负值，位于零轴左侧）" : ""}`} />;
          })}
        </div>
        <div className={`decomp-identity ${ok ? "ok" : "bad"}`}>
          {ok ? "✓" : "✗"} {cfg.parts.length} 项加总 = {fmt(sum, cfg.unit)} · 与 {cfg.totalLabel} 的误差 {error.toExponential(1)}
        </div>
        {negligible && <div className="decomp-hint">⚠️ {country} · {sectorLabel(sector)} 的{total === 0 ? `${cfg.totalLabel}=0` : `${cfg.totalLabel}占本国行业合计不足 0.01%`}，建议换一个活跃行业。</div>}
        <table className="decomp-table">
          <tbody>{cfg.parts.map((part, index) => {
            const value = values[index];
            const share = total ? (value / total) * 100 : 0;
            return <tr key={part.key} className={hover === part.key ? "on" : ""}
              onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}>
              <td className="dt-name"><span className="dt-swatch" style={{ background: value < 0 ? "#e34948" : part.color }} />{part.label}</td>
              <td className="dt-val">{fmt(value, cfg.unit)}</td><td className="dt-share">{share.toFixed(1)}%</td><td className="dt-desc">{part.desc}</td>
            </tr>;
          })}</tbody>
        </table>
        {step === 6 && <MiniBackwardBar row={row} />}
        {cfg.note && <div className="decomp-note">📌 {cfg.note(row)}</div>}
      </div>
    );
  };

  return (
    <div className="demo-card">
      <div className="demo-title">🧮 动手拆解 · 看着分项加回总量</div>
      <div className="demo-controls">
        <div className="pill-group">
          <button className={gran === "sector" ? "on" : ""} onClick={() => setGran("sector")}>国家–行业级</button>
          <button className={gran === "country" ? "on" : ""} onClick={() => setGran("country")}>国家级</button>
        </div>
        <LabeledControl label="共享年份">
          {(id) => (
            <select id={id} value={year} onChange={(event) => {
              const next = Number(event.target.value);
              setYear(next);
              onPrimaryChange?.(next, countryA);
            }}>{meta.years.map((value) => <option key={value}>{value}</option>)}</select>
          )}
        </LabeledControl>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /> 双实体并排对比
        </label>
      </div>
      {step === 4 && <div className="tipbox taxsub-explainer" style={{ marginBottom: 12 }}>
        <div className="taxsub-explainer-copy">
          <strong>为什么 taxsub 可能为负？</strong>
          <span>taxsub 是出口直接及间接所含的产品税减补贴。负值表示沿供应链累计后呈净补贴，不代表该行业直接获得同额补贴。</span>
        </div>
        {negativeExample ? <button
          type="button"
          className="taxsub-example-button"
          aria-pressed={gran === "sector" && year === exampleYear && countryA === exampleCountry && effSectorA === String(negativeExample.industry)}
          title={`该计算示例的 taxsub 为 ${fmt(num(negativeExample.taxsub), "amount")} 百万美元，占毛出口 ${(num(negativeExample.taxsub) / num(negativeExample.gross_exports) * 100).toFixed(1)}%`}
          onClick={() => {
            setGran("sector");
            setYear(exampleYear);
            setCountryA(exampleCountry);
            setSectorA(String(negativeExample.industry));
            onPrimaryChange?.(exampleYear, exampleCountry);
            onExampleChange?.(exampleYear, exampleCountry);
          }}
        >
          <span>查看 ICIO {exampleYear} 计算示例：{countryLabel(exampleCountry)} · {sectorLabel(String(negativeExample.industry))}</span>
          <small>
            taxsub {num(negativeExample.taxsub).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 百万美元
            · 占毛出口 {(num(negativeExample.taxsub) / num(negativeExample.gross_exports) * 100).toFixed(1)}%
          </small>
        </button> : <span className="taxsub-example-status">
          {exampleError ? "计算示例暂时无法加载。" : examplePage ? "当前数据中没有满足展示条件的负值示例。" : "正在加载计算示例…"}
        </span>}
      </div>}
      <div className="decomp-formula"><span className="df-total">{cfg.totalLabel}</span><span className="df-eq">=</span>{cfg.parts.map((part, index) => <span key={part.key}>{index > 0 && <span className="df-plus">+</span>}<span className={`df-term${hover === part.key ? " on" : ""}`} style={hover === part.key ? { color: part.color, borderColor: part.color } : undefined} onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}>{part.label.split(" ")[0]}</span></span>)}</div>
      <div style={{ display: "grid", gridTemplateColumns: compare ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 18 }}>
        {panel(rowA, "A", pageA, effSectorA, countryA)}
        {compare && panel(rowB, "B", pageB, effSectorB, countryB)}
      </div>
    </div>
  );
}

/* ============================ 步骤6:网络中心性演示 ============================ */

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

const ekey = (a: string, b: string) => `${a}→${b}`;

function computeCentrality() {
  const ids = NET_NODES.map((n) => n.id);
  const out: Record<string, string[]> = {};
  const incoming: Record<string, string[]> = {};
  ids.forEach((i) => { out[i] = []; incoming[i] = []; });
  NET_EDGES.forEach(([a, b]) => { out[a].push(b); incoming[b].push(a); });

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
      for (const w of out[v]) {
        if (d[w] === Infinity) { d[w] = d[v] + 1; q.push(w); }
        if (d[w] === d[v] + 1) { sg[w] += sg[v]; pr[w].push(v); }
      }
    }
    dist[s] = d; sigma[s] = sg; preds[s] = pr;
  });

  // Brandes 累积介数中心性：有向、无权、原始计数，不归一化。
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
  const deg: Record<string, number> = {};
  const indeg: Record<string, number> = {};
  const outdeg: Record<string, number> = {};
  ids.forEach((i) => {
    indeg[i] = incoming[i].length;
    outdeg[i] = out[i].length;
    deg[i] = indeg[i] + outdeg[i];
  });
  const closeness: Record<string, number> = {};
  ids.forEach((i) => {
    const reachable = ids.filter((target) => target !== i && Number.isFinite(dist[i][target]));
    const distanceSum = reachable.reduce((sum, target) => sum + dist[i][target], 0);
    closeness[i] = distanceSum ? reachable.length / distanceSum : 0;
  });

  return { out, incoming, dist, sigma, preds, deg, indeg, outdeg, bet, closeness };
}

function shortestPath(from: string, to: string, C: ReturnType<typeof computeCentrality>): string[] {
  const path = [to];
  let current = to;
  while (current !== from) {
    const previous = C.preds[from][current][0];
    if (previous == null) return [];
    path.push(previous);
    current = previous;
  }
  return path.reverse();
}

// 重建一条经过 v 的、跨度尽量大的最短路径,用于高亮演示
function samplePathThrough(v: string, C: ReturnType<typeof computeCentrality>): string[] {
  const ids = NET_NODES.map((n) => n.id);
  let best: string[] = [];
  let bestLen = -1;
  for (const s of ids) for (const t of ids) {
    if (s === t || s === v || t === v || !Number.isFinite(C.dist[s][t])) continue;
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
  const [mode, setMode] = useState<"degree" | "betweenness" | "closeness">("degree");
  const [sel, setSel] = useState<string>("DEU");

  const pathNodes = mode === "betweenness" ? samplePathThrough(sel, C) : [];
  const pathEdges = new Set<string>();
  for (let i = 0; i + 1 < pathNodes.length; i++) pathEdges.add(ekey(pathNodes[i], pathNodes[i + 1]));
  const distancePaths = NET_NODES.filter((node) => node.id !== sel).map((node) => ({
    target: node.id,
    distance: C.dist[sel][node.id],
    path: shortestPath(sel, node.id, C),
  }));
  if (mode === "closeness") distancePaths.forEach(({ path }) => {
    for (let i = 0; i + 1 < path.length; i++) pathEdges.add(ekey(path[i], path[i + 1]));
  });
  const neighbors = new Set([...C.out[sel], ...C.incoming[sel]]);

  const edgeActive = (a: string, b: string) =>
    mode === "degree"
      ? a === sel || b === sel
      : pathEdges.has(ekey(a, b));

  const selNode = NET_NODES.find((n) => n.id === sel)!;
  const reachablePaths = distancePaths.filter((item) => Number.isFinite(item.distance));
  const distanceSum = reachablePaths.reduce((sum, item) => sum + item.distance, 0);
  const visualMax = Math.max(...NET_NODES.map((node) => (
    mode === "degree" ? C.deg[node.id] : mode === "betweenness" ? C.bet[node.id] : C.closeness[node.id]
  )), 1e-9);

  return (
    <div className="demo-card">
      <div className="demo-title">🕸️ 动手演示 · 中心性是怎么数出来的</div>
      <div className="demo-controls">
        <div className="pill-group">
          <button className={mode === "degree" ? "on" : ""} onClick={() => setMode("degree")}>度中心性</button>
          <button className={mode === "betweenness" ? "on" : ""} onClick={() => setMode("betweenness")}>介数中心性</button>
          <button className={mode === "closeness" ? "on" : ""} onClick={() => setMode("closeness")}>接近中心性</button>
        </div>
        <span className="muted">点节点查看它的中心性</span>
      </div>

      <div className="net-demo-wrap">
        <svg viewBox="0 0 620 340" className="net-demo-svg">
          <defs>
            <marker id="net-demo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L0,6 L8,3 z" fill="context-stroke" />
            </marker>
          </defs>
          {NET_EDGES.map(([a, b]) => {
            const na = NET_NODES.find((n) => n.id === a)!;
            const nb = NET_NODES.find((n) => n.id === b)!;
            const active = edgeActive(a, b);
            const length = Math.hypot(nb.x - na.x, nb.y - na.y) || 1;
            const ux = (nb.x - na.x) / length;
            const uy = (nb.y - na.y) / length;
            return (
              <line
                key={ekey(a, b)}
                x1={na.x + ux * 28} y1={na.y + uy * 28}
                x2={nb.x - ux * 32} y2={nb.y - uy * 32}
                stroke={active ? "#4b47e0" : "#d8dbe6"}
                strokeWidth={active ? 3.5 : 1.5}
                markerEnd="url(#net-demo-arrow)"
              />
            );
          })}
          {NET_NODES.map((n) => {
            const isSel = n.id === sel;
            const isNeighbor = mode === "degree" && neighbors.has(n.id);
            const onPath = mode !== "degree" && (mode === "closeness" || pathNodes.includes(n.id));
            const val = mode === "degree" ? C.deg[n.id] : mode === "betweenness" ? C.bet[n.id] : C.closeness[n.id];
            const r = 18 + (val / visualMax) * 20;
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
              <div className="ndp-formula">度 = 入度 + 出度（原始边数）</div>
              <div className="ndp-calc">
                = {C.indeg[sel]} + {C.outdeg[sel]} = <b>{C.deg[sel]}</b>
              </div>
              <p className="ndp-note">
                高亮的是全部入边和出边。Gephi 中自环会分别计入一次入度和一次出度，因此总度计两次。
              </p>
            </>
          ) : mode === "betweenness" ? (
            <>
              <div className="ndp-formula">介数中心性 = Σ σₛₜ(v) / σₛₜ（有向原始计数）</div>
              <div className="ndp-calc">= <b>{C.bet[sel].toFixed(3)}</b></div>
              <p className="ndp-note">
                {pathNodes.length >= 3
                  ? <>例如 {pathNodes[0]} → {pathNodes[pathNodes.length - 1]} 的无权最短路要穿过 {sel}(已高亮)。越多这类路径对经过它，拓扑介数越高；这不自动说明它是经济瓶颈。</>
                  : <>{selNode.label} 很少落在别人的最短路径上,介数中心性低。</>}
              </p>
            </>
          ) : (
            <>
              <div className="ndp-formula">接近中心性 = 沿出边可达节点数 / 最短距离和</div>
              <div className="ndp-calc">
                {reachablePaths.length > 0
                  ? <>= {reachablePaths.length} / {distanceSum} = <b>{C.closeness[sel].toFixed(3)}</b></>
                  : <>无可达节点；按 Gephi 约定记为 <b>0.000</b></>}
              </div>
              <p className="ndp-note">高亮边组成从 {sel} 沿箭头出发的最短路径树；不可达节点不进入分子和分母。</p>
              <div style={{ maxHeight: 150, overflow: "auto", marginBottom: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead><tr><th style={{ textAlign: "left" }}>目标</th><th>距离</th><th style={{ textAlign: "left" }}>一条最短路径</th></tr></thead>
                  <tbody>{distancePaths.sort((a, b) => a.distance - b.distance || a.target.localeCompare(b.target)).map((item) => (
                    <tr key={item.target}><td>{item.target}</td><td style={{ textAlign: "center" }}>{Number.isFinite(item.distance) ? item.distance : "不可达"}</td><td>{item.path.length ? item.path.join(" → ") : "—"}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
          <div className="ndp-disclaim">
            这是一个 7 节点的有向演示网络。真实系统保留全部正流量边和正自环，在完整的全球「国家×行业」生产网络上按同一 Gephi 口径计算。
          </div>
        </div>
      </div>
    </div>
  );
}
