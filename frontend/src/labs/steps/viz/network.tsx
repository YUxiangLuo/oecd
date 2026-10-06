/**
 * 步骤 9 · 网络可视化 —— 故事:「流量规模与二值拓扑会讲同一个故事吗?」
 *
 * 记录视角:行业的历年变化与排名,以全部经济体同一行业为参照,再与对比国家比较;按学生最后查看的完整图表自动记录报告材料。
 * 探索视角(同一视角栏,不记录材料):
 *   流量与拓扑  一国各行业的加权总度(对数)×二值介数散点(主题视角,默认进入)
 *   买入与卖出  一国各行业的加权入度与出度蝴蝶图
 *   贸易伙伴    国家级贸易网络读成自我中心图、伙伴榜、区域流向矩阵与伙伴集中度
 *   全部指标表  折叠在"国家对比"视角里,一个国家全部行业节点的多项网络指标,可排序
 *
 * 口径:国家级贸易图是完全图 → 无权中心性(度 / 介数 …)恒为常数、无区分度,
 * 因此二值拓扑比较只在国家–行业级做(见 country_degenerate 处理与回归 network 粒度)。
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { IndustryPage, Meta, Step, StepStateApi } from "../../../types";
import { HeatTableViz, countryLabel } from "../../../viz";
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
import { NetworkTrend } from "./network-trend";
import { TradePartners } from "./trade-partners";
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
      title={`${countryLabel(drill)} 的行业网络指标（在全球网络上计算，按${heatSortLabel(heatSort)}显示${heatCoverageLabel(heatCoverage)}）`}
      what={<>选一个国家，每行是一个行业。加权总度是流入加流出的金额（正自环计两次）；介数把小额和大额的边一视同仁。可切换排序，查看前 15 个或全部行业。</>}
      read={<>介数高只说明在不计流量的网络中，更多最短路径经过这个行业；它不能证明流量大，也不能说明是经济枢纽或瓶颈。对比加权总度和介数两种排序，看它们是否一致。</>}
      find={<>本表仅供查数，不记录报告材料；报告材料由主图自动记录。</>}
      note="指标在完整的全球国家×行业网络上计算，选择国家只改变显示哪些行。介数没有做边阈值检验，只作探索性参考。"
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
  const { year, setYear, pickCountries, schema } = useVizLab(meta, step, state, STEP10_DEFAULT_LENS, STEP10_LENS_KEYS);
  const observations = (state.data?.observations ?? []).filter((item) => item.source === "explicit-network-trend" || item.source === "explicit-network-ranking");
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  // The heat table follows country A ([A, B] in compared) unless the student picked a country in a modal.
  const [pickedDrill, setDrill] = useState<string | undefined>(state.data?.drill);
  const drill = [pickedDrill, state.data?.compared?.[0], fallbackDrill].find((country) => country && meta.countries.includes(country)) ?? "";
  const [heatSort, setHeatSort] = useState<HeatSortMetric>(normalizeHeatSortMetric(state.data?.heat_sort));
  const [heatCoverage, setHeatCoverage] = useState<HeatCoverage>(normalizeHeatCoverage(state.data?.heat_coverage));
  const drillTouched = useRef(Boolean(state.data));
  useEffect(() => {
    if (drillTouched.current || !state.data) return;
    if (state.data.drill) setDrill(state.data.drill);
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
      <NetworkTrend
        meta={meta}
        schema={schema}
        initialCountry={drill}
        initialCountries={state.data?.compared ?? []}
        observations={observations}
        syncing={state.syncing}
        syncError={state.syncError}
        onRetrySync={state.syncNow}
        locked={state.materialLocked}
        onRecord={(countries, records) => {
          pickCountries(countries);
          state.save({ compared: countries, metric: records[0]?.metric, observations: records });
        }}
        extraLenses={[{ key: "partners", label: "贸易伙伴" }]}
        renderExtra={(_key, countries) => <TradePartners meta={meta} countries={countries} year={year} onYear={setYear} />}
        renderTable={() => (
          <IndustryHeatTable
            meta={meta} initialYear={year} drill={drill} heatSort={heatSort} heatCoverage={heatCoverage}
            onDrill={inspectCountry} onSort={changeHeatSort} onCoverage={changeHeatCoverage}
          />
        )}
      />
    </div>
  );
}
