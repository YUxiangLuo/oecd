import { useState } from "react";
import { api } from "../../api";
import type { IndicatorSchema, IndustryPage, Meta, NetworkData, Step } from "../../types";
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
    defaultView: "composition",
    rankMetric: "3b_VA_GVC_C_share",
    scatter: ["3_VA_GVC_share", "3b_VA_GVC_C_share"],
    composition: ["1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C"],
    columns: ["SVA", "3_VA_GVC_share", "3b_VA_GVC_C_share", "3a_VA_GVC_S", "3b_VA_GVC_C"],
    framing: "一国的增加值有多少停留在国内、多少进入简单 / 复杂 GVC?对比生产活动的四段构成(WWYZ)。",
  },
  10: {
    group: "length",
    views: ["signature", "scatter", "rank", "trend", "table"],
    defaultView: "scatter",
    rankMetric: "PLv",
    scatter: ["PLv_GVC", "PLy_GVC"],
    columns: ["PLv", "PLv_GVC", "PLy", "PLy_GVC", "Pos_TPL", "GVCPs"],
    framing: "生产链有多长?前向 PLv 看增加值到最终吸收端的距离,后向 PLy 看最终品回溯到初始投入端的距离,GVCPs 衡量相对位置。",
  },
  11: {
    group: "network",
    views: ["signature", "quadrant", "rank", "scatter", "trend", "table"],
    defaultView: "quadrant",
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
        {step.n === 11 && view === "signature" && (
          <span className="field">
            <label>下钻国家</label>
            <select value={drillCountry} onChange={(e) => setDrillCountry(e.target.value)}>
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
              <button className={granularity === "country" ? "on" : ""} onClick={() => setGranularity("country")}>国家级</button>
              <button
                className={granularity === "sector" ? "on" : ""}
                onClick={() => { setGranularity("sector"); setEntityMode("topn"); }}
              >
                行业下钻
              </button>
            </div>
          )}
          {granularity === "sector" && (
            <span className="field">
              <label>下钻国家</label>
              <select value={drillCountry} onChange={(e) => setDrillCountry(e.target.value)}>
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
          {granularity === "country" && (
            <div className="seg">
              <button className={entityMode === "topn" ? "on" : ""} onClick={() => setEntityMode("topn")}>{view === "quadrant" ? "全部" : "Top-N"}</button>
              <button className={entityMode === "pick" ? "on" : ""} onClick={() => setEntityMode("pick")}>选国家</button>
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
            <CountryPicker countries={meta.countries} picked={picked} onChange={setPicked} />
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
