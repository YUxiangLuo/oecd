import { useState } from "react";
import { api } from "../../api";
import type { IndicatorSchema, Meta, NetworkData, SectorPage, Step } from "../../types";
import { CompositionBar, HeatTableViz, LengthViz, NetworkViz, QuadrantScatter, RankBarChart, ScatterChart, sectorLabel, StackedShareViz, TrendChart } from "../../viz";
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
  defaultView: ViewKind;             // 重挂时默认落在的探索视图
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
    defaultView: "quadrant",
    rankMetric: "share_trade_gvc_participation",
    scatter: ["share_trade_gvc_participation", "share_trade_dva"],
    quadrant: ["share_trade_backward_gvc", "share_trade_forward_gvc"],
    quadLabels: ["双高·深度嵌入", "前向主导·卖中间品", "双低·相对自给", "后向主导·买中间品"],
    composition: ["share_trade_dva", "share_trade_fva", "share_trade_pdc"],
    columns: ["share_trade_gvc_participation", "share_trade_backward_gvc", "share_trade_forward_gvc", "trade_gross_exports"],
    framing: "每个经济体的出口在 GVC 中处于什么位置?比较后向(用别人的中间品)与前向(被别人用作中间品)参与度。",
  },
  9: {
    group: "production",
    views: ["signature", "composition", "rank", "scatter", "trend", "table"],
    defaultView: "composition",
    rankMetric: "share_prod_complex_gvc",
    scatter: ["share_prod_gvc_total", "share_prod_complex_gvc"],
    composition: ["share_prod_pure_domestic", "share_prod_traditional", "share_prod_simple_gvc", "share_prod_complex_gvc"],
    columns: ["share_prod_complex_gvc", "share_prod_simple_gvc", "share_prod_traditional", "share_prod_pure_domestic"],
    framing: "一国的增加值有多少停留在国内、多少进入简单 / 复杂 GVC?对比生产结构的四段构成。",
  },
  10: {
    group: "length",
    views: ["signature", "scatter", "rank", "composition", "trend", "table"],
    defaultView: "scatter",
    rankMetric: "upstreamness",
    scatter: ["upstreamness_domestic", "upstreamness_cross"],
    composition: ["upstreamness_domestic", "upstreamness_cross"],
    columns: ["upstreamness", "upstreamness_domestic", "upstreamness_cross"],
    framing: "生产链有多长?拆成国内段与跨境段,看链条长度的来源。",
  },
  11: {
    group: "network",
    views: ["signature", "quadrant", "rank", "scatter", "trend", "table"],
    defaultView: "quadrant",
    rankMetric: "degree_centrality",
    scatter: ["degree_centrality", "betweenness_centrality"],
    quadrant: ["degree_centrality", "betweenness_centrality"],
    quadLabels: ["核心枢纽", "桥接者(高介数)", "边缘", "枢纽连接者(高度)"],
    columns: ["betweenness_centrality", "degree_centrality", "eigenvector_centrality"],
    framing: "谁是生产网络的枢纽?高度中心性=连接多,高介数中心性=控扼要冲,四象限区分四类角色。",
  },
};

/** 步骤8-11:主题化可视化探索(每步招牌图 + 本主题的默认图表/指标 + 自由探索)。
 *  App.tsx 用 key={step.n} 挂载,切步即重挂 → 下面所有初值按本步 cfg 重新生效。 */
export function VizLab({ meta, step }: { meta: Meta; step: Step }) {
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
  const [granularity, setGranularity] = useState<"country" | "sector">("country");
  const [drillCountry, setDrillCountry] = useState(meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const isNetwork = step.n === 8;

  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);
  const { data: rows, error } = useAsync(() => api.countryIndicators(year), [year]);
  const { data: sectorPage, error: sectorErr } = useAsync<SectorPage | null>(
    () => (granularity === "sector" && drillCountry
      ? api.sectorIndicatorsAll(year, drillCountry)
      : Promise.resolve(null)),
    [granularity, year, drillCountry],
  );
  const { data: net, error: netErr } = useAsync<NetworkData | null>(
    () => (isNetwork ? api.network(year) : Promise.resolve(null)),
    [year, isNetwork],
  );
  // 趋势图需要全部年份的国家级指标(按需拉取,服务端 CSV 已按 mtime 缓存)
  const { data: yearsData } = useAsync<Record<string, string | number | null>[][] | null>(
    () => (view === "trend" && granularity === "country"
      ? Promise.all(meta.years.map((y) => api.countryIndicators(y)))
      : Promise.resolve(null)),
    [view === "trend", granularity],
  );
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
  const selRows =
    granularity === "sector"
      ? allRows.filter(metricOk).sort((a, b) => num(b[effX]) - num(a[effX])).slice(0, topN)
      : entityMode === "topn"
      ? allRows.filter(metricOk).sort((a, b) => num(b[effX]) - num(a[effX])).slice(0, topN)
      : allRows.filter((r) => picked.includes(String(r.country)) && metricOk(r));
  const highlight = granularity === "country" ? new Set(picked) : new Set<string>();

  // 趋势图折线:Top-N 模式限 6 条以内保证可读,选国家模式用全部选中国家
  const trendCountries =
    granularity === "sector"
      ? []
      : entityMode === "pick"
      ? picked
      : [...allRows].sort((a, b) => num(b[rankBy]) - num(a[rankBy])).slice(0, Math.min(topN, 6)).map((r) => String(r.country));
  const trendSeries = trendCountries.map((c) => ({
    country: c,
    values: meta.years.map((_, i) => {
      const r = (yearsData?.[i] ?? []).find((row) => String(row.country) === c);
      return r ? num(r[rankBy]) : NaN;
    }),
  }));

  const signatureChart = () => {
    if (isNetwork) return net ? <NetworkViz data={net} /> : <p className="muted">加载中…</p>;
    if (!rows) return <p className="muted">加载中…</p>;
    if (step.n === 9) return <StackedShareViz rows={rows} />;
    if (step.n === 10) return <LengthViz rows={rows} />;
    return <HeatTableViz rows={rows} />;
  };

  // 指标选择器默认只列本步主题组;勾选「全部指标」放开到全部四组。
  const shownGroups = allMetrics ? (schema?.groups ?? []) : (schema?.groups ?? []).filter((g) => g.key === cfg.group);
  const metricSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <span className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {shownGroups.map((g) => (
          <optgroup key={g.key} label={g.label}>
            {g.fields.map((f) => <option key={f} value={f}>{schema?.fields[f]?.label ?? f}</option>)}
          </optgroup>
        ))}
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
      <div className="controls">
        <span className="field">
          <label>年份</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {meta.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </span>
        <div className="seg">
          {TABS.map(([k, lab]) => (
            <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{lab}</button>
          ))}
        </div>
      </div>

      {/* 自由探索:一行引导语 + 控件条(选粒度 / 选指标 / 选对象;招牌图不需要) */}
      {view !== "signature" && <p className="viz-framing muted">{cfg.framing}</p>}
      {view !== "signature" && (
        <div className="controls viz-explore">
          <div className="seg">
            <button className={granularity === "country" ? "on" : ""} onClick={() => setGranularity("country")}>国家级</button>
            <button
              className={granularity === "sector" ? "on" : ""}
              onClick={() => { setGranularity("sector"); setEntityMode("topn"); }}
            >
              行业下钻
            </button>
          </div>
          {granularity === "sector" && (
            <span className="field">
              <label>下钻国家</label>
              <select value={drillCountry} onChange={(e) => setDrillCountry(e.target.value)}>
                {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
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
          {granularity === "country" && (
            <div className="seg">
              <button className={entityMode === "topn" ? "on" : ""} onClick={() => setEntityMode("topn")}>Top-N</button>
              <button className={entityMode === "pick" ? "on" : ""} onClick={() => setEntityMode("pick")}>选国家</button>
            </div>
          )}
          {granularity === "sector" || entityMode === "topn" ? (
            <span className="topn-ctl">
              前 <input type="range" min={5} max={40} value={topN} onChange={(e) => setTopN(Number(e.target.value))} />
              <b>{view === "trend" && granularity === "country" ? Math.min(topN, 6) : topN}</b>
              个(按{view === "scatter" ? "X" : "该"}指标{view === "trend" && granularity === "country" ? ",趋势最多6条" : ""})
            </span>
          ) : (
            <select multiple className="country-multi" value={picked}
              onChange={(e) => setPicked(Array.from(e.target.selectedOptions, (o) => o.value))}>
              {meta.countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
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
        granularity === "sector" ? <p className="muted">趋势图暂使用国家级时间序列;切回“国家级”后可查看 2016–2020 趋势。</p>
          : !yearsData ? <p className="muted">加载多年数据中…</p>
          : trendSeries.length
            ? <TrendChart years={meta.years} series={trendSeries} label={fieldLabel(rankBy, schema)} format={fmtOf(rankBy)} />
            : <p className="muted">请在“选国家”里选择国家(或切到 Top-N)。</p>
      )}

      {view === "table" && (
        sectorLoading ? <p className="muted">加载 {drillCountry} 行业指标中…</p> : <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{granularity === "sector" ? "行业" : "国家"}</th>{cfg.columns.map((c) => <th key={c}>{fieldLabel(c, schema)}</th>)}</tr></thead>
            <tbody>
              {selRows.map((r) => (
                <tr key={String(r.sector ?? r.country)}>
                  <td>{r.sector != null ? sectorLabel(String(r.sector)) : String(r.country)}</td>
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

