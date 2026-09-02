/**
 * 步骤 9 · 网络可视化 —— 故事:「流量规模与二值拓扑会讲同一个故事吗?」
 *
 * 网络专属镜头(与前三步完全不同的图元):
 *   贸易网络图  国家间双边贸易流的有向网络,悬停看某国的伙伴与区域集群
 *   网络指标表  选一国,看它各行业节点在**完整全球国家×行业图**上的流量与拓扑指标
 *
 * 口径:国家级贸易图是完全图 → 无权中心性(度 / 介数 …)恒为常数、无区分度,
 * 因此二值拓扑比较只在国家–行业级做(见 country_degenerate 处理与回归 network 粒度)。
 * 对比对象累加网络图点开的国家和热力表下钻；取消选中不回退。
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import { FullscreenPanel } from "../../../fullscreen-panel";
import type { IndustryPage, Meta, NetworkData, Step, StepStateApi } from "../../../types";
import { HeatTableViz, NetworkViz, countryLabel } from "../../../viz";
import {
  HEAT_COVERAGE_OPTIONS,
  HEAT_EVIDENCE_METRIC,
  HEAT_SORT_OPTIONS,
  heatCoverageLabel,
  heatRowKey,
  heatSortLabel,
  normalizeHeatCoverage,
  normalizeHeatSortMetric,
  sameHeatView,
  visibleHeatRows,
  type HeatActivation,
  type HeatCoverage,
  type HeatSortMetric,
  type HeatViewOptions,
} from "../../../viz/views/network-heat";
import { AsyncStateMessage, useAsync } from "../../shared";
import {
  addInspectedCountry,
  ChartStory,
  invalidateVizObservations,
  LensNav,
  observationRequestIdentity,
  observationRequestKey,
  sameObservationIdentity,
  YearSelect,
  useVizLab,
  type ObservationRequestIdentity,
  type Row,
  type VizObservation,
  type VizStepState,
} from "./scaffold";

type Lens = "heat" | "network";

export const STEP10_DEFAULT_LENS: Lens = "network";
export const STEP10_LENSES: { key: Lens; label: string; hint: string }[] = [
  { key: "network", label: "贸易网络图", hint: "国家间双边流向" },
  { key: "heat", label: "行业网络指标", hint: "一国各行业的流量与拓扑基准" },
];
const STEP10_LENS_KEYS = STEP10_LENSES.map(({ key }) => key);

export function heatObservationFromActivation(
  activation: HeatActivation,
  sourceIdentity: ObservationRequestIdentity | null,
  currentIdentity: ObservationRequestIdentity | null,
  rows: readonly Row[],
  currentView: HeatViewOptions,
): VizObservation | null {
  if (!sameObservationIdentity(sourceIdentity, currentIdentity)
    || !sourceIdentity
    || sourceIdentity.scope !== "country-industry"
    || !sourceIdentity.country
    || activation.metric !== HEAT_EVIDENCE_METRIC
    || heatRowKey(activation.row) !== activation.rowKey
    || normalizeHeatSortMetric(activation.sortMetric) !== activation.sortMetric
    || normalizeHeatCoverage(activation.coverage) !== activation.coverage
    || !sameHeatView(activation, currentView)) return null;
  const visible = visibleHeatRows(rows, activation.sortMetric, activation.coverage);
  const authoritative = visible[activation.visibleIndex];
  if (!authoritative
    || heatRowKey(authoritative) !== activation.rowKey
    || activation.row[HEAT_EVIDENCE_METRIC] !== authoritative[HEAT_EVIDENCE_METRIC]
    || activation.row[activation.sortMetric] !== authoritative[activation.sortMetric]
    || String(authoritative.country ?? "") !== sourceIdentity.country) return null;
  const value = authoritative[HEAT_EVIDENCE_METRIC];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const industry = String(authoritative.industry ?? "");
  return {
    entity: `${sourceIdentity.country}·${industry}`,
    country: sourceIdentity.country,
    industry,
    year: sourceIdentity.year,
    value,
    metric: HEAT_EVIDENCE_METRIC,
    release: sourceIdentity.release,
    scope: sourceIdentity.scope,
    generation: sourceIdentity.generation,
    request_key: sourceIdentity.requestKey,
    source: "explicit-heat-row",
  };
}

export function nextExplicitHeatObservations(
  prior: readonly VizObservation[],
  next: VizObservation,
): VizObservation[] {
  return [
    ...prior.filter((item) => item.source === "explicit-heat-row"
      && item.release === next.release
      && item.year === next.year
      && item.scope === next.scope
      && item.country !== next.country),
    next,
  ].slice(-2);
}

function heatIdentityToken(identity: ObservationRequestIdentity): string {
  return `${identity.requestKey}\u0000${identity.generation}`;
}

export function NetworkVizStep({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries, schema } = useVizLab(
    meta, step, state, STEP10_DEFAULT_LENS, STEP10_LENS_KEYS,
  );
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [drill, setDrill] = useState(state.data?.drill ?? state.data?.compared?.at(-1) ?? fallbackDrill);
  const [heatSort, setHeatSort] = useState<HeatSortMetric>(
    normalizeHeatSortMetric(state.data?.heat_sort),
  );
  const [heatCoverage, setHeatCoverage] = useState<HeatCoverage>(
    normalizeHeatCoverage(state.data?.heat_coverage),
  );
  const [heatAutoExpandSignal, setHeatAutoExpandSignal] = useState(0);
  const [activeHeat, setActiveHeat] = useState<{ identity: string; rowKey: string } | null>(null);
  const explicitHeatHistory = useRef<VizObservation[]>(
    (state.data?.observations ?? []).filter((item) => item.source === "explicit-heat-row"),
  );
  const drillTouched = useRef(Boolean(state.data));
  useEffect(() => {
    if (drillTouched.current || !state.data) return;
    const saved = state.data.drill ?? state.data.compared?.at(-1);
    if (saved && meta.countries.includes(saved)) setDrill(saved);
    setHeatSort(normalizeHeatSortMetric(state.data.heat_sort));
    setHeatCoverage(normalizeHeatCoverage(state.data.heat_coverage));
    drillTouched.current = true;
  }, [state.data, meta.countries]);

  const heatRequestKey = observationRequestKey(meta, year, "country-industry", drill)
    ?? `missing-release:${year}:country-industry:${drill}`;
  const pageQuery = useAsync<IndustryPage>(
    () => api.industryIndicatorsAll(year, drill),
    [lens, year, drill],
    { enabled: lens === "heat" && Boolean(drill), requestKey: heatRequestKey },
  );
  const networkQuery = useAsync<NetworkData>(
    () => api.network(year),
    [lens, year],
    { enabled: lens === "network" },
  );
  const page = pageQuery.data;
  const net = networkQuery.data;
  const heatRows = (page?.rows ?? []) as Row[];
  const acceptedHeatIdentity = page && lens === "heat"
    ? observationRequestIdentity(meta, year, "country-industry", pageQuery.generation, drill)
    : null;
  const currentHeatIdentity = useRef<ObservationRequestIdentity | null>(acceptedHeatIdentity);
  const heatView: HeatViewOptions = { sortMetric: heatSort, coverage: heatCoverage };
  const currentHeatView = useRef<HeatViewOptions>(heatView);
  // Render-time assignment makes queued callbacks compare against the latest request/view,
  // rather than waiting for an effect after year/country/retry/view changes.
  currentHeatIdentity.current = acceptedHeatIdentity;
  currentHeatView.current = heatView;

  const clearHeatEvidence = () => {
    setActiveHeat(null);
    invalidateVizObservations(state);
  };
  const inspectCountry = (country: string) => {
    if (!meta.countries.includes(country)) return;
    drillTouched.current = true;
    if (country !== drill) clearHeatEvidence();
    setDrill(country);
    pickCountries(addInspectedCountry(picked, country, meta.countries));
    state.save({ drill: country });
  };
  const changeYear = (next: number) => {
    if (next !== year) {
      explicitHeatHistory.current = [];
      setActiveHeat(null);
    }
    setYear(next);
  };
  const changeLens = (next: Lens) => {
    if (next === "heat" && lens !== "heat") {
      clearHeatEvidence();
      setHeatAutoExpandSignal((signal) => signal + 1);
    }
    pickLens(next);
  };
  const retryHeat = () => {
    clearHeatEvidence();
    pageQuery.retry();
  };
  const changeHeatSort = (next: HeatSortMetric) => {
    const normalized = normalizeHeatSortMetric(next);
    currentHeatView.current = { ...currentHeatView.current, sortMetric: normalized };
    setHeatSort(normalized);
    state.save({ heat_sort: normalized });
  };
  const changeHeatCoverage = (next: HeatCoverage) => {
    const normalized = normalizeHeatCoverage(next);
    currentHeatView.current = { ...currentHeatView.current, coverage: normalized };
    setHeatCoverage(normalized);
    state.save({ heat_coverage: normalized });
  };
  const activateHeatRow = (activation: HeatActivation) => {
    const sourceIdentity = acceptedHeatIdentity;
    const observation = heatObservationFromActivation(
      activation,
      sourceIdentity,
      currentHeatIdentity.current,
      heatRows,
      currentHeatView.current,
    );
    if (!observation || !sourceIdentity) return;
    const prior = [
      ...explicitHeatHistory.current,
      ...(state.data?.observations ?? []).filter((item) => item.source === "explicit-heat-row"),
    ];
    const observations = nextExplicitHeatObservations(prior, observation);
    explicitHeatHistory.current = observations;
    pickCountries(addInspectedCountry(picked, observation.country, meta.countries));
    state.save({ metric: HEAT_EVIDENCE_METRIC, observations });
    setActiveHeat({ identity: heatIdentityToken(sourceIdentity), rowKey: activation.rowKey });
  };
  const activeHeatRowKey = acceptedHeatIdentity
    && activeHeat?.identity === heatIdentityToken(acceptedHeatIdentity)
    ? activeHeat.rowKey
    : null;

  return (
    <div>
      <div className="tipbox" style={{ marginBottom: 14 }}>
        国家级贸易图在全部正流量边下是<b>完全图</b>,度、介数、接近等无权中心性对所有国家恒为常数、没有区分度。
        因此拓扑比较在<b>国家–行业级</b>的完整全球图上做:每个数值都在包含全部国家×行业节点和所有正中间品流量边的有向图上计算,下钻只改变展示范围。
        先把<b>加权度</b>当作经济流量规模基准，再把无权介数作为拓扑敏感性视角；当前未检验删去微小边后排序是否稳定。
      </div>

      <div className="controls" style={{ marginBottom: 12 }}>
        <YearSelect years={meta.years} year={year} onChange={changeYear} />
        <span className="muted" style={{ fontSize: 12 }}>
          已看过 <b style={{ color: picked.length >= 2 ? "#159a86" : "#e0982a" }}>{picked.length}</b> 国{picked.length < 2 ? "（报告建议 ≥2）" : ""}
        </span>
      </div>

      <LensNav<Lens> active={lens as Lens} onPick={changeLens} lenses={STEP10_LENSES} />

      <FullscreenPanel
        title={`步骤 ${step.n} · ${countryLabel(drill)}行业网络指标表`}
        variant="heat"
        buttonLabel="全屏查看"
        enabled={lens === "heat"}
        autoExpandSignal={heatAutoExpandSignal}
      >
        {lens === "heat" ? (
          <ChartStory
            eyebrow="国家×行业网络"
            title={`${countryLabel(drill)} 的行业节点网络指标(全球图上计算,按${heatSortLabel(heatSort)}显示${heatCoverageLabel(heatCoverage)})`}
            what={<>选一个国家，每行是一个行业节点。加权总度=入向+出向流量（正自环双计）；全正边二值介数把微小正边与大额边视为等长。可切换排序并查看 Top 15 或全部有限行业。</>}
            read={<>二值介数高只表示在这套全正边拓扑中，更多有向最短路径份额经过该节点；它不是流量大、经济枢纽或瓶颈的证明。对比加权总度与介数排序，观察流量规模和拓扑编码是否给出不同故事。</>}
            find={<>换看两三个国家，并比较两种排序；选择实际查看的一行，点击“记录拓扑基准”。记录时必须保留“全正边、二值、未归一化、未做边阈值敏感性”四项限定。</>}
            note="指标在完整全球国家×行业图上计算，下钻只筛选展示行。当前没有边阈值敏感性分析，所以二值介数只作探索性拓扑基准；加权总度中的正自环在入向、出向各计一次。"
          >
            <div className="controls" style={{ marginBottom: 12 }}>
              <LabeledControl label="下钻国家">
                {(id) => (
                  <select id={id} value={drill} onChange={(e) => inspectCountry(e.target.value)}>
                    {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
                  </select>
                )}
              </LabeledControl>
              <LabeledControl label="排序指标">
                {(id) => (
                  <select id={id} value={heatSort} onChange={(e) => changeHeatSort(e.target.value as HeatSortMetric)}>
                    {HEAT_SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                  </select>
                )}
              </LabeledControl>
              <LabeledControl label="显示范围">
                {(id) => (
                  <select id={id} value={heatCoverage} onChange={(e) => changeHeatCoverage(e.target.value as HeatCoverage)}>
                    {HEAT_COVERAGE_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                  </select>
                )}
              </LabeledControl>
              <span className="muted" role="note">排序只改变可见顺序；报告证据固定记录全正边二值介数。</span>
            </div>
            {pageQuery.status === "loading" || pageQuery.status === "error" ? (
              <AsyncStateMessage
                status={pageQuery.status}
                error={pageQuery.error}
                loadingLabel={`加载 ${countryLabel(drill)} 行业网络指标中…`}
                onRetry={retryHeat}
              />
            ) : visibleHeatRows(heatRows, heatSort, heatCoverage).length ? (
              <HeatTableViz
                rows={heatRows}
                schema={schema}
                onActivate={activateHeatRow}
                activeRowKey={activeHeatRowKey}
                sortMetric={heatSort}
                coverage={heatCoverage}
                countryName={countryLabel(drill)}
              />
            )
              : <p className="muted">该国无行业数据。</p>}
          </ChartStory>
        ) : (
          <ChartStory
            eyebrow="双边贸易网络"
            title="国家间生产贸易网络(有向,预设地理区域布局)"
            what={<>节点 = 经济体,有向边 = 跨国中间品 + 最终品贸易流(不含国内边);点大小 / 边粗细反映流量规模。节点位置按预设地理区域排布，不是社区检测结果。</>}
            read={<>在预设区域内与区域间比较流向；悬停一个国家只高亮当前截止比例下仍显示的伙伴，点击后进入大图并打开同一批可见边的流入、流出伙伴表。箭头方向是"卖给谁"。国家图使用跨国中间品 + 最终品且不含国内边，行业中心性图只用中间品并保留正自环，两者不只是粒度不同。</>}
            find={<>比较中国、美国、德国在各自预设地理区域内及跨区域的流向；注意国家层几乎两两相连(接近完全图),这正是无权中心性在国家级退化的原因，不表示布局发现了社区。</>}
            note="显示截止是当前发布 Top 边最大流量的百分比，只同步影响绘边、伙伴高亮、悬停、详情表与有向边文本表；完整图中心性不变。行业中心性计算用完整的中间品图，不受国家图显示截止影响。因节点与边定义不同，国家图不是行业中心性图的简单下钻。"
          >
            {networkQuery.status === "loading" || networkQuery.status === "error" ? (
              <AsyncStateMessage
                status={networkQuery.status}
                error={networkQuery.error}
                loadingLabel={`加载 ${year} 年贸易网络中…`}
                onRetry={networkQuery.retry}
              />
            ) : net ? <NetworkViz data={net} onInspectCountry={inspectCountry} /> : <p className="muted">该年份暂无网络数据。</p>}
          </ChartStory>
        )}
      </FullscreenPanel>
    </div>
  );
}
