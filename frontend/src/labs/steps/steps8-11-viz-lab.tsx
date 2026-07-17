import { useEffect, useState } from "react";
import { api } from "../../api";
import { EvidencePanel } from "../../step-evidence";
import type { IndicatorSchema, IndustryPage, Meta, NetworkData, Step, StepEvidenceApi } from "../../types";
import { CompositionBar, HeatTableViz, LengthViz, NetworkViz, QuadrantScatter, RankBarChart, ScatterChart, countryLabel, sectorLabel, StackedShareViz, TrendChart } from "../../viz";
import { CountryPicker } from "../country-picker";
import { fieldLabel, fmtField, useAsync } from "../shared";

type ViewKind = "signature" | "rank" | "scatter" | "quadrant" | "composition" | "trend" | "table";
const num = (v: string | number | null | undefined) => (typeof v === "number" ? v : 0);

const VIEW_LABELS: Record<ViewKind, string> = {
  signature: "招牌图", quadrant: "象限图", composition: "构成图",
  rank: "排序条形图", scatter: "散点图", trend: "趋势图", table: "表格",
};

interface StepVizConfig {
  group: string;                     // 主题指标组(与 schema.groups[].key 对应),用于作用域指标选择器
  views: ViewKind[];                 // 本步的标签集(依次;首=招牌,尾=表格)
  defaultView: ViewKind;             // 重挂时默认落在的视图
  rankMetric: string;                // 排序/构成/趋势的默认指标
  scatter: [string, string];         // 散点默认 X/Y
  quadrant?: [string, string];       // 象限图固定 X/Y
  quadLabels?: [string, string, string, string]; // 象限四角标签 [右上,左上,左下,右下]
  composition?: string[];            // 构成条的分段指标(依次)
  columns: string[];                 // 表格列
  framing: string;                   // 一行引导语
}

// 每步的主题化探索配置:切步即重挂并重置为本步主题(见 App.tsx 的 key={step.n})。
// 合并了旧的 SCATTER_DEFAULT 与 App.tsx 的 VIZ_COLUMNS。
const STEP_VIZ: Record<number, StepVizConfig> = {
  8: {
    group: "trade",
    views: ["signature", "quadrant", "composition", "rank", "scatter", "table"],
    defaultView: "signature",
    rankMetric: "FVA_share",
    scatter: ["FVA_share", "DVAex_share"],
    quadrant: ["FVA_share", "3_VA_GVC_share"],
    quadLabels: ["双高·深度嵌入", "GVC生产主导·前向型", "双低·相对自给", "进口依赖·后向型"],
    composition: ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"],
    columns: ["gross_exports", "DVAex", "FVA", "taxsub", "FVA_share"],
    framing: "每个经济体的出口值从哪里来?比较 FVA 份额(用别人的增加值)与 GVC 生产份额(增加值经中间品贸易实现)。",
  },
  9: {
    group: "production",
    views: ["signature", "composition", "rank", "scatter", "trend", "table"],
    defaultView: "signature",
    rankMetric: "3b_VA_GVC_C_share",
    scatter: ["3_VA_GVC_share", "3b_VA_GVC_C_share"],
    composition: ["1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C"],
    columns: ["SVA", "3_VA_GVC_share", "3b_VA_GVC_C_share", "3a_VA_GVC_S", "3b_VA_GVC_C"],
    framing: "一国的增加值有多少停留在国内、多少进入简单 / 复杂 GVC?对比生产活动的四段构成(WWYZ)。",
  },
  10: {
    group: "length",
    views: ["signature", "scatter", "rank", "trend", "table"],
    defaultView: "signature",
    rankMetric: "PLv",
    scatter: ["PLv_GVC", "PLy_GVC"],
    columns: ["PLv", "PLv_GVC", "PLy", "PLy_GVC", "Pos_TPL", "GVCPs"],
    framing: "生产链有多长?前向 PLv 看增加值到最终吸收端的距离,后向 PLy 看最终品回溯到初始投入端的距离,GVCPs 衡量相对位置。",
  },
  11: {
    group: "network",
    views: ["signature", "quadrant", "rank", "scatter", "trend", "table"],
    defaultView: "signature",
    rankMetric: "weighted degree",
    scatter: ["weighted degree", "betweenesscentrality"],
    quadrant: ["weighted degree", "betweenesscentrality"],
    quadLabels: ["核心枢纽", "桥接者(高介数)", "边缘", "枢纽连接者(高加权度)"],
    columns: ["degree", "weighted degree", "betweenesscentrality", "closnesscentrality", "harmonicclosnesscentrality", "eigencentrality"],
    framing: "在全球国家×行业有向图中识别枢纽。当前下钻显示所选国家的全部行业节点，但中心性始终由完整全球图共同计算。",
  },
};

/** 步骤8-11:主题化可视化探索(每步招牌图 + 本主题的默认图表/指标 + 自由探索)。
 *  App.tsx 用 key={step.n} 挂载,切步即重挂 → 下面所有初值按本步 cfg 重新生效。 */
/** 第 8–11 步的学习证据:选定一个图表视角,并自选至少两个对比对象。 */
interface VizEvidence extends Record<string, unknown> {
  chart?: string;
  compared?: string[];
}

export function VizLab({ meta, step, evidence }: {
  meta: Meta;
  step: Step;
  evidence: StepEvidenceApi<VizEvidence>;
}) {
  const cfg = STEP_VIZ[step.n] ?? STEP_VIZ[8];
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [view, setView] = useState<ViewKind>(cfg.defaultView);
  // 单指标视图(排序/构成/趋势)用 rankBy;散点用 metricX/Y —— 分开存,互不干扰默认值
  const [rankBy, setRankBy] = useState(cfg.rankMetric);
  const [metricX, setMetricX] = useState(cfg.scatter[0]);
  const [metricY, setMetricY] = useState(cfg.scatter[1]);
  const [allMetrics, setAllMetrics] = useState(false);
  const [entityMode, setEntityMode] = useState<"topn" | "pick">("topn");
  const [topN, setTopN] = useState(15);
  const [picked, setPicked] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<"country" | "sector">(step.n === 11 ? "sector" : "country");
  const [drillCountry, setDrillCountry] = useState(meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const [tableSort, setTableSort] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);
  const isNetwork = step.n === 8;

  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);
  const { data: rows, error } = useAsync<Record<string, string | number | null>[] | null>(
    () => (step.n === 11 ? Promise.resolve(null) : api.countryIndicators(year)),
    [year, step.n],
  );
  const { data: sectorPage, error: sectorErr } = useAsync<IndustryPage | null>(
    () => (granularity === "sector" && drillCountry
      ? api.industryIndicatorsAll(year, drillCountry)
      : Promise.resolve(null)),
    [granularity, year, drillCountry],
  );
  const { data: net, error: netErr } = useAsync<NetworkData | null>(
    () => (isNetwork ? api.network(year) : Promise.resolve(null)),
    [year, isNetwork],
  );
  // 趋势图按当前粒度拉取全部年份指标(按需请求,服务端 CSV 已按 mtime 缓存)
  const { data: yearsData } = useAsync<Record<string, string | number | null>[][] | null>(
    () => view === "trend"
      ? granularity === "country"
        ? Promise.all(meta.years.map((y) => api.countryIndicators(y)))
        : Promise.all(meta.years.map((y) => api.industryIndicatorsAll(y, drillCountry))).then((pages) => pages.map((page) => page.rows))
      : Promise.resolve(null),
    [view === "trend", granularity, drillCountry],
  );
  // 证据:选定了图表视角,并**自选**了对比对象。
  // 刻意不采信 Top-N 自动选出来的实体:那是系统替学生选的,不构成学生的比较决定。
  // 必须放在下面的早退之前:hook 不能在条件返回之后调用。
  //
  // 只有学生**真正动过**这三项才写证据(interacted 由各个 onClick/onChange 置位)。
  // App.tsx 用 key={step.n} 挂载本组件,切回一个已完成的步骤会重挂并把
  // view/entityMode/picked 重置为默认值;若照写就会用默认值覆盖学生存下的证据,
  // 让做过的步骤退回未完成。
  //
  // 不能用“跳过 effect 的第一次运行”来实现:StrictMode 下 effect 会被
  // 有意二次调用(run → cleanup → run),而 ref 在同一个组件实例里是延续的,
  // 于是第二次运行照样把默认值写了出去。守卫必须挂在真实用户事件上,
  // 与 step1-db 的 pickedSlice 同一个道理。
  const [interacted, setInteracted] = useState(false);
  useEffect(() => {
    if (!interacted) return;
    if (granularity === "sector") {
      // 国家×行业节点(第 11 步):这里没有、也不该有国家多选——国家级贸易图
      // 在全正边下是完全图,Gephi 介数恒为 0,所以这一步被固定在 sector 粒度。
      // 因此“对比对象”来自「下钻国家」:看过哪几个国家的行业节点构成。
      // 累加而不是覆盖,学生下钻过的国家一个都不会丢。
      const seen = evidence.data?.compared ?? [];
      evidence.save({
        chart: view,
        compared: seen.includes(drillCountry) ? seen : [...seen, drillCountry],
      });
    } else {
      evidence.save({ chart: view, compared: entityMode === "pick" ? picked : [] });
    }
    // evidence 每次渲染都是新对象,不入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interacted, view, entityMode, picked, granularity, drillCountry]);

  /** 包装用户驱动的 setter:动过才算学生的选择。 */
  const withEvidence = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setInteracted(true);
  };
  const pickView = withEvidence(setView);
  const pickEntityMode = withEvidence(setEntityMode);
  const pickCountries = withEvidence(setPicked);
  const pickDrillCountry = withEvidence(setDrillCountry);
  // 切到国家级时,若当前选中的是国家级退化的网络中心性(在国家级选择器里已隐藏),
  // 回落到本步默认指标,避免 select 指向空值、或画出恒为常数的“幽灵”图。
  const pickGranularity = (value: "country" | "sector") => {
    if (value === "country") {
      const degenerate = (f: string) => schema?.fields[f]?.country_degenerate;
      if (degenerate(rankBy)) setRankBy(cfg.rankMetric);
      if (degenerate(metricX)) setMetricX(cfg.scatter[0]);
      if (degenerate(metricY)) setMetricY(cfg.scatter[1]);
    }
    setGranularity(value);
    setInteracted(true);
  };

  if (error || netErr || sectorErr) return <div className="error-box">{error ?? netErr ?? sectorErr}</div>;

  const fmtOf = (k: string) => schema?.fields[k]?.format;
  const groupOf = (f: string) => (schema?.groups ?? []).find((g) => g.fields.includes(f))?.key;
  const allRows = granularity === "sector" ? (sectorPage?.rows ?? []) : (rows ?? []);
  const sectorLoading = granularity === "sector" && !sectorPage;
  // 有效主/次轴:象限=固定 cfg.quadrant;散点=metricX/Y;其余单指标视图=rankBy。
  const twoAxis = view === "scatter" || view === "quadrant";
  const effX = view === "quadrant" ? cfg.quadrant![0] : view === "scatter" ? metricX : rankBy;
  const effY = view === "quadrant" ? cfg.quadrant![1] : metricY;
  // 占比/长度指标对"实际不出口的行业"是缺失(null):排序/散点/象限/构成里剔除,避免把它们
  // 当成 0 画出幽灵条/原点(表格视图保留、以"—"如实显示)。
  const isFin = (v: string | number | null | undefined) => typeof v === "number" && Number.isFinite(v);
  const needFilter = view === "rank" || view === "scatter" || view === "quadrant" || view === "composition";
  const metricOk = (r: Record<string, string | number | null>) =>
    !needFilter || (isFin(r[effX]) && (!twoAxis || isFin(r[effY])));
  // 选中的对象:Top-N(按有效X指标排序)或手动挑选的国家
  const validRows = allRows.filter(metricOk);
  const selRows = view === "quadrant"
    ? granularity === "country" && entityMode === "pick"
      ? validRows.filter((row) => picked.includes(String(row.country)))
      : validRows
    : granularity === "sector"
      ? validRows.sort((a, b) => num(b[effX]) - num(a[effX])).slice(0, topN)
      : entityMode === "topn"
        ? validRows.sort((a, b) => num(b[effX]) - num(a[effX])).slice(0, topN)
        : validRows.filter((r) => picked.includes(String(r.country)));
  const highlight = granularity === "country" ? new Set(picked) : new Set<string>();

  // 趋势图折线:Top-N 模式限 6 条以内保证可读,选国家模式用全部选中国家
  const trendEntities =
    granularity === "sector"
      ? [...allRows].filter((row) => isFin(row[rankBy])).sort((a, b) => num(b[rankBy]) - num(a[rankBy]))
        .slice(0, Math.min(topN, 6)).map((row) => String(row.industry))
      : entityMode === "pick"
      ? picked
      : [...allRows].sort((a, b) => num(b[rankBy]) - num(a[rankBy])).slice(0, Math.min(topN, 6)).map((r) => String(r.country));
  const trendSeries = trendEntities.map((entity) => ({
    country: granularity === "sector" ? sectorLabel(entity) : countryLabel(entity),
    values: meta.years.map((_, i) => {
      const r = (yearsData?.[i] ?? []).find((row) => String(row[granularity === "sector" ? "industry" : "country"]) === entity);
      return r && isFin(r[rankBy]) ? num(r[rankBy]) : NaN;
    }),
  }));

  const tableRows = !tableSort ? selRows : [...selRows].sort((a, b) => {
    const entity = (row: Record<string, string | number | null>) => row.industry != null ? sectorLabel(String(row.industry)) : countryLabel(String(row.country ?? ""));
    const av = tableSort.key === "__entity__" ? entity(a) : a[tableSort.key];
    const bv = tableSort.key === "__entity__" ? entity(b) : b[tableSort.key];
    const aMissing = av == null || (typeof av === "number" && !Number.isFinite(av));
    const bMissing = bv == null || (typeof bv === "number" && !Number.isFinite(bv));
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "zh-CN");
    return tableSort.direction === "asc" ? cmp : -cmp;
  });
  const toggleTableSort = (key: string) => setTableSort((current) => current?.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "desc" });

  const signatureChart = () => {
    if (isNetwork) return net ? <NetworkViz data={net} /> : <p className="muted">加载中…</p>;
    if (step.n === 11) {
      return sectorPage
        ? <HeatTableViz rows={sectorPage.rows} schema={schema} />
        : <p className="muted">加载 {drillCountry} 行业网络指标中…</p>;
    }
    if (!rows) return <p className="muted">加载中…</p>;
    if (step.n === 9) return <StackedShareViz rows={rows} />;
    if (step.n === 10) return <LengthViz rows={rows} />;
    return <HeatTableViz rows={rows} schema={schema} />;
  };

  // 指标选择器默认只列本步主题组;勾选「全部指标」放开到全部四组。
  const shownGroups = allMetrics ? (schema?.groups ?? []) : (schema?.groups ?? []).filter((g) => g.key === cfg.group);
  const metricSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <span className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {shownGroups.map((g) => {
          // 国家级贸易图是完全图:无权网络中心性对所有国家恒为常数,从国家级选择器隐藏
          // (加权度=贸易量仍保留);行业级不受影响。schema 的 country_degenerate 标记为准。
          const fields = g.fields.filter((f) => granularity !== "country" || !schema?.fields[f]?.country_degenerate);
          return fields.length ? (
            <optgroup key={g.key} label={g.label}>
              {fields.map((f) => <option key={f} value={f}>{schema?.fields[f]?.label ?? f}</option>)}
            </optgroup>
          ) : null;
        })}
      </select>
    </span>
  );
  // 收起「全部指标」时,若当前选的是跨主题指标,回落到本步默认,避免 select 指向被隐藏的选项。
  const toggleAllMetrics = (on: boolean) => {
    setAllMetrics(on);
    if (!on) {
      if (groupOf(rankBy) !== cfg.group) setRankBy(cfg.rankMetric);
      if (groupOf(metricX) !== cfg.group) setMetricX(cfg.scatter[0]);
      if (groupOf(metricY) !== cfg.group) setMetricY(cfg.scatter[1]);
    }
  };

  const TABS: [ViewKind, string][] = cfg.views.map((v) => [v, VIEW_LABELS[v]]);
  const showMetricPicker = view !== "signature" && view !== "table" && view !== "quadrant";

  return (
    <div>
      <EvidencePanel
        evidence={evidence}
        // 提示必须指向界面上真实存在的控件名。sector 粒度(第 11 步)没有国家多选,
        // 对比对象来自「下钻国家」;country 粒度要先离开招牌图才会出现「选国家」。
        title={granularity === "sector"
          ? "本步要留下的证据:点选一个图表视角,并用「下钻国家」看过至少两个国家的行业节点"
          : "本步要留下的证据:点选一个图表视角(招牌图以外),再用「选国家」挑出至少两个对比对象"}
      />
      <div className="controls">
        <span className="field">
          <label>年份</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </span>
        <div className="seg">
          {TABS.map(([k, lab]) => (
            <button key={k} className={view === k ? "on" : ""} onClick={() => pickView(k)}>{lab}</button>
          ))}
        </div>
        {step.n === 11 && view === "signature" && (
          <span className="field">
            <label>下钻国家</label>
            <select value={drillCountry} onChange={(e) => pickDrillCountry(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          </span>
        )}
      </div>

      {/* 自由探索:一行引导语 + 控件条(选粒度 / 选指标 / 选对象;招牌图不需要) */}
      {view !== "signature" && <p className="viz-framing muted">{cfg.framing}</p>}
      {view !== "signature" && (
        <div className="controls viz-explore">
          {step.n === 11 ? (
            <span className="muted">分析粒度：国家–行业级（完整全球网络）</span>
          ) : (
            <div className="seg">
              <button className={granularity === "country" ? "on" : ""} onClick={() => pickGranularity("country")}>国家级</button>
              <button
                className={granularity === "sector" ? "on" : ""}
                onClick={() => { pickGranularity("sector"); pickEntityMode("topn"); }}
              >
                行业下钻
              </button>
            </div>
          )}
          {granularity === "sector" && (
            <span className="field">
              <label>下钻国家</label>
              <select value={drillCountry} onChange={(e) => pickDrillCountry(e.target.value)}>
                {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
              </select>
            </span>
          )}
          {showMetricPicker && (view === "scatter"
            ? metricSelect(metricX, setMetricX, "X 指标")
            : metricSelect(rankBy, setRankBy, "指标"))}
          {view === "scatter" && metricSelect(metricY, setMetricY, "Y 指标")}
          {showMetricPicker && (
            <label className="field metric-scope">
              <input type="checkbox" checked={allMetrics} onChange={(e) => toggleAllMetrics(e.target.checked)} />
              全部指标
            </label>
          )}
          {granularity === "country" && allMetrics && (
            <span className="muted" style={{ fontSize: 12, flexBasis: "100%" }}>
              国家级贸易图为完全图,无权网络中心性(度 / 介数 / 接近 / 离心 / 调和 / 特征向量)对所有国家恒为常数,已从国家级隐藏;如需比较请切到「行业下钻」。加权度(贸易量)仍可用。
            </span>
          )}
          {granularity === "country" && (
            <div className="seg">
              <button className={entityMode === "topn" ? "on" : ""} onClick={() => pickEntityMode("topn")}>{view === "quadrant" ? "全部" : "Top-N"}</button>
              <button className={entityMode === "pick" ? "on" : ""} onClick={() => pickEntityMode("pick")}>选国家</button>
            </div>
          )}
          {view !== "quadrant" && (granularity === "sector" || entityMode === "topn") ? (
            <span className="topn-ctl">
              前 <input type="range" min={5} max={40} value={topN} onChange={(e) => setTopN(Number(e.target.value))} />
              <b>{view === "trend" ? Math.min(topN, 6) : topN}</b>
              个(按{view === "scatter" ? "X" : "该"}指标{view === "trend" ? ",趋势最多6条" : ""})
            </span>
          ) : view === "quadrant" && (granularity === "sector" || entityMode === "topn") ? (
            <span className="muted">显示全部 {validRows.length} 个有效样本；参考线始终按完整样本计算</span>
          ) : (
            <CountryPicker countries={meta.countries} picked={picked} onChange={pickCountries} />
          )}
        </div>
      )}

      {step.n === 11 && (
        <div className="tipbox" style={{ marginBottom: 12 }}>
          当前只列出 {drillCountry} 的行业节点；每个数值均在包含全部国家×行业节点和所有正中间品流量边的全球有向图上计算。国家级图的介数恒为 0，故本步骤不展示国家级中心性比较。
        </div>
      )}

      {view === "signature" && signatureChart()}

      {view === "rank" && (
        sectorLoading ? <p className="muted">加载 {drillCountry} 行业指标中…</p>
          : selRows.length
          ? <RankBarChart rows={selRows} metricKey={rankBy} label={fieldLabel(rankBy, schema)} format={fmtOf(rankBy)} highlight={highlight} />
          : <p className="muted">请在“选国家”里选择至少一个国家。</p>
      )}

      {view === "scatter" && (
        sectorLoading ? <p className="muted">加载 {drillCountry} 行业指标中…</p>
          : selRows.length
          ? <ScatterChart rows={selRows} xKey={metricX} yKey={metricY}
              xLabel={fieldLabel(metricX, schema)} yLabel={fieldLabel(metricY, schema)}
              xFormat={fmtOf(metricX)} yFormat={fmtOf(metricY)} highlight={highlight} />
          : <p className="muted">请在“选国家”里选择至少一个国家。</p>
      )}

      {view === "quadrant" && cfg.quadrant && (
        sectorLoading ? <p className="muted">加载 {drillCountry} 行业指标中…</p>
          : selRows.length
          ? <QuadrantScatter rows={selRows} xKey={cfg.quadrant[0]} yKey={cfg.quadrant[1]}
              referenceRows={validRows}
              xLabel={fieldLabel(cfg.quadrant[0], schema)} yLabel={fieldLabel(cfg.quadrant[1], schema)}
              xFormat={fmtOf(cfg.quadrant[0])} yFormat={fmtOf(cfg.quadrant[1])}
              highlight={highlight} quadrantLabels={cfg.quadLabels} />
          : <p className="muted">请在“选国家”里选择至少一个国家。</p>
      )}

      {view === "composition" && cfg.composition && (
        sectorLoading ? <p className="muted">加载 {drillCountry} 行业指标中…</p>
          : selRows.length
          ? <CompositionBar rows={selRows}
              segments={cfg.composition.map((k) => ({ key: k, name: fieldLabel(k, schema) }))}
              sortKey={rankBy} sortLabel={fieldLabel(rankBy, schema)} sortFormat={fmtOf(rankBy)}
              normalize={step.n !== 10} valueFormat={fmtOf(cfg.composition[0])} highlight={highlight} />
          : <p className="muted">请在“选国家”里选择至少一个国家。</p>
      )}

      {view === "trend" && (
        !yearsData ? <p className="muted">加载{granularity === "sector" ? `${drillCountry} 行业` : "国家"}多年数据中…</p>
          : trendSeries.length
            ? <TrendChart years={meta.years} series={trendSeries} label={fieldLabel(rankBy, schema)} format={fmtOf(rankBy)} />
            : <p className="muted">没有可绘制的有效时间序列。</p>
      )}

      {view === "table" && (
        sectorLoading ? <p className="muted">加载 {drillCountry} 行业指标中…</p> : <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th style={{ position: "sticky", left: 0, zIndex: 3, background: "#fafbfd" }}>
                <button onClick={() => toggleTableSort("__entity__")} style={{ border: 0, background: "transparent", font: "inherit", cursor: "pointer" }}>
                  {granularity === "sector" ? "行业" : "国家"}{tableSort?.key === "__entity__" ? (tableSort.direction === "asc" ? " ↑" : " ↓") : " ↕"}
                </button>
              </th>
              {cfg.columns.map((c) => <th key={c} title={schema?.fields[c]?.desc}>
                <button onClick={() => toggleTableSort(c)} style={{ border: 0, background: "transparent", font: "inherit", cursor: "pointer" }}>
                  {fieldLabel(c, schema)}{tableSort?.key === c ? (tableSort.direction === "asc" ? " ↑" : " ↓") : " ↕"}
                </button>
              </th>)}
            </tr></thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={String(r.industry ?? r.country)}>
                  <td style={{ position: "sticky", left: 0, zIndex: 2, background: "#fff" }}>{r.industry != null ? sectorLabel(String(r.industry)) : countryLabel(String(r.country))}</td>
                  {cfg.columns.map((c) => <td key={c}>{fmtField(r[c], c, schema)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
