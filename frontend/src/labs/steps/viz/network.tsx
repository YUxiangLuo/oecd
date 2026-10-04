/**
 * 步骤 9 · 网络可视化 —— 故事:「流量规模与二值拓扑会讲同一个故事吗?」
 *
 * 主图:两国行业比较(历年趋势 / 行业排名),按学生最后查看的完整图表自动记录报告材料。
 * 补充图表(弹窗,不替换主图):
 *   贸易联系概览  国家间双边贸易流的有向网络,悬停看某国的伙伴与区域集群
 *   单国行业热力表  一个国家全部行业节点的多项网络指标,可排序
 *
 * 口径:国家级贸易图是完全图 → 无权中心性(度 / 介数 …)恒为常数、无区分度,
 * 因此二值拓扑比较只在国家–行业级做(见 country_degenerate 处理与回归 network 粒度)。
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { IndustryPage, Meta, NetworkData, Step, StepStateApi } from "../../../types";
import { HeatTableViz, NetworkViz, countryLabel } from "../../../viz";
import {
  HEAT_COVERAGE_OPTIONS,
  HEAT_SORT_OPTIONS,
  heatCoverageLabel,
  heatSortLabel,
  normalizeHeatCoverage,
  normalizeHeatSortMetric,
  visibleHeatRows,
  type HeatCoverage,
  type HeatSortMetric,
} from "../../../viz/views/network-heat";
import { AsyncStateMessage, useAsync } from "../../shared";
import { ChartModalButton, SupplementaryCharts } from "./chart-modal";
import { NetworkTrend } from "./network-trend";
import {
  ChartStory,
  observationRequestKey,
  YearSelect,
  useVizLab,
  type Row,
  type VizStepState,
} from "./scaffold";

type Lens = "heat" | "network";

/** The step's main chart is the two-country industry comparison; the network overview is a modal. */
export const STEP10_DEFAULT_LENS: Lens = "heat";
const STEP10_LENS_KEYS: Lens[] = ["heat", "network"];

function TradeNetworkOverview({ meta, initialYear, onInspectCountry }: {
  meta: Meta;
  initialYear: number;
  onInspectCountry: (country: string) => void;
}) {
  const [year, setYear] = useState(initialYear);
  const networkQuery = useAsync<NetworkData>(() => api.network(year), [year]);
  const net = networkQuery.data;
  return (
    <ChartStory
      eyebrow="双边贸易网络"
      title="国家间生产贸易网络(有向,预设地理区域布局)"
      what={<>节点 = 经济体,有向边 = 跨国中间品 + 最终品贸易流(不含国内边);点大小 / 边粗细反映流量规模。节点位置按预设地理区域排布，不是社区检测结果。</>}
      read={<>在预设区域内与区域间比较流向；悬停一个国家只高亮当前截止比例下仍显示的伙伴，点击后打开同一批可见边的流入、流出伙伴表。箭头方向是"卖给谁"。</>}
      find={<>比较中国、美国、德国在各自预设地理区域内及跨区域的流向；注意国家层几乎两两相连(接近完全图),这正是无权中心性在国家级退化的原因，不表示布局发现了社区。</>}
      note="这张图与主图不能直接对应：概览以国家为节点，展示跨国中间品＋最终品流量，不含国内边；主图与步骤 5 同源，指标在完整国家×行业中间品网络上计算，包含国内联系和正自环。不要用概览中的位置解释某行业的中心性。显示截止只影响绘边与伙伴高亮，完整图中心性不变。"
    >
      <div className="controls" style={{ marginBottom: 12 }}>
        <YearSelect years={meta.years} year={year} onChange={setYear} />
      </div>
      {networkQuery.status === "loading" || networkQuery.status === "error" ? (
        <AsyncStateMessage
          status={networkQuery.status}
          error={networkQuery.error}
          loadingLabel={`加载 ${year} 年贸易网络中…`}
          onRetry={networkQuery.retry}
        />
      ) : net ? <NetworkViz data={net} onInspectCountry={onInspectCountry} /> : <p className="muted">该年份暂无网络数据。</p>}
    </ChartStory>
  );
}

function IndustryHeatTable({ meta, initialYear, drill, heatSort, heatCoverage, onDrill, onSort, onCoverage }: {
  meta: Meta;
  initialYear: number;
  drill: string;
  heatSort: HeatSortMetric;
  heatCoverage: HeatCoverage;
  onDrill: (country: string) => void;
  onSort: (metric: HeatSortMetric) => void;
  onCoverage: (coverage: HeatCoverage) => void;
}) {
  const [year, setYear] = useState(initialYear);
  const { data: schema } = useAsync(() => api.indicatorSchema(), []);
  const requestKey = observationRequestKey(meta, year, "country-industry", drill) ?? `missing-release:${year}:country-industry:${drill}`;
  const pageQuery = useAsync<IndustryPage>(() => api.industryIndicatorsAll(year, drill), [year, drill], { enabled: Boolean(drill), requestKey });
  const heatRows = (pageQuery.data?.rows ?? []) as Row[];
  return (
    <ChartStory
      eyebrow="国家×行业网络"
      title={`${countryLabel(drill)} 的行业节点网络指标(全球图上计算,按${heatSortLabel(heatSort)}显示${heatCoverageLabel(heatCoverage)})`}
      what={<>选一个国家，每行是一个行业节点。加权总度=入向+出向流量（正自环双计）；全正边二值介数把微小正边与大额边视为等长。可切换排序并查看 Top 15 或全部有限行业。</>}
      read={<>二值介数高只表示在这套全正边拓扑中，更多有向最短路径份额经过该节点；它不是流量大、经济枢纽或瓶颈的证明。对比加权总度与介数排序，观察流量规模和拓扑编码是否给出不同故事。</>}
      find={<>本表仅供查数，不参与报告材料收集；报告材料由主图自动记录。</>}
      note="指标在完整全球国家×行业图上计算，下钻只筛选展示行。当前没有边阈值敏感性分析，所以二值介数只作探索性拓扑基准；加权总度中的正自环在入向、出向各计一次。"
    >
      <div className="controls" style={{ marginBottom: 12 }}>
        <YearSelect years={meta.years} year={year} onChange={setYear} />
        <LabeledControl label="下钻国家">
          {(id) => (
            <select id={id} value={drill} onChange={(e) => onDrill(e.target.value)}>
              {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="排序指标">
          {(id) => (
            <select id={id} value={heatSort} onChange={(e) => onSort(e.target.value as HeatSortMetric)}>
              {HEAT_SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="显示范围">
          {(id) => (
            <select id={id} value={heatCoverage} onChange={(e) => onCoverage(e.target.value as HeatCoverage)}>
              {HEAT_COVERAGE_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          )}
        </LabeledControl>
      </div>
      {pageQuery.status === "loading" || pageQuery.status === "error" ? (
        <AsyncStateMessage
          status={pageQuery.status}
          error={pageQuery.error}
          loadingLabel={`加载 ${countryLabel(drill)} 行业网络指标中…`}
          onRetry={pageQuery.retry}
        />
      ) : visibleHeatRows(heatRows, heatSort, heatCoverage).length ? (
        <HeatTableViz rows={heatRows} schema={schema} sortMetric={heatSort} coverage={heatCoverage} countryName={countryLabel(drill)} />
      ) : <p className="muted">该国无行业数据。</p>}
    </ChartStory>
  );
}

export function NetworkVizStep({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, pickCountries, schema } = useVizLab(meta, step, state, STEP10_DEFAULT_LENS, STEP10_LENS_KEYS);
  const observations = (state.data?.observations ?? []).filter((item) => item.source === "explicit-network-trend" || item.source === "explicit-network-ranking");
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [drill, setDrill] = useState(state.data?.drill ?? state.data?.compared?.at(-1) ?? fallbackDrill);
  const [heatSort, setHeatSort] = useState<HeatSortMetric>(normalizeHeatSortMetric(state.data?.heat_sort));
  const [heatCoverage, setHeatCoverage] = useState<HeatCoverage>(normalizeHeatCoverage(state.data?.heat_coverage));
  const drillTouched = useRef(Boolean(state.data));
  useEffect(() => {
    if (drillTouched.current || !state.data) return;
    const saved = state.data.drill ?? state.data.compared?.at(-1);
    if (saved && meta.countries.includes(saved)) setDrill(saved);
    setHeatSort(normalizeHeatSortMetric(state.data.heat_sort));
    setHeatCoverage(normalizeHeatCoverage(state.data.heat_coverage));
    drillTouched.current = true;
  }, [state.data, meta.countries]);

  const inspectCountry = (country: string) => {
    if (!meta.countries.includes(country)) return;
    drillTouched.current = true;
    setDrill(country);
    state.save({ drill: country });
  };
  const changeHeatSort = (next: HeatSortMetric) => {
    const normalized = normalizeHeatSortMetric(next);
    setHeatSort(normalized);
    state.save({ heat_sort: normalized });
  };
  const changeHeatCoverage = (next: HeatCoverage) => {
    const normalized = normalizeHeatCoverage(next);
    setHeatCoverage(normalized);
    state.save({ heat_coverage: normalized });
  };

  return (
    <div>
      <NetworkTrend meta={meta} schema={schema} initialCountry={drill} observations={observations} syncing={state.syncing} syncError={state.syncError} onRetrySync={state.syncNow} onRecord={(countries, records) => {
        pickCountries(countries);
        state.save({ compared: countries, metric: records[0]?.metric, observations: records });
      }} />
      <SupplementaryCharts>
        <ChartModalButton label="贸易联系概览（国家间网络图）" title={`步骤 ${step.n} · 国家间贸易联系概览`}>
          {() => <TradeNetworkOverview meta={meta} initialYear={year} onInspectCountry={inspectCountry} />}
        </ChartModalButton>
        <ChartModalButton label="单国行业热力表" title={`步骤 ${step.n} · ${countryLabel(drill)} 行业网络指标`}>
          {() => (
            <IndustryHeatTable
              meta={meta} initialYear={year} drill={drill} heatSort={heatSort} heatCoverage={heatCoverage}
              onDrill={inspectCountry} onSort={changeHeatSort} onCoverage={changeHeatCoverage}
            />
          )}
        </ChartModalButton>
      </SupplementaryCharts>
    </div>
  );
}
