/**
 * 步骤 9 · 网络可视化 —— 故事:「流量规模与二值拓扑会讲同一个故事吗?」
 *
 * 网络专属镜头(与前三步完全不同的图元):
 *   贸易网络图  国家间双边贸易流的有向网络,悬停看某国的伙伴与区域集群
 *   行业趋势  同一行业的单国时间序列或两国比较；行业指标表作为可选明细保留
 *
 * 口径:国家级贸易图是完全图 → 无权中心性(度 / 介数 …)恒为常数、无区分度,
 * 因此二值拓扑比较只在国家–行业级做(见 country_degenerate 处理与回归 network 粒度)。
 * 只有行业图表材料卡保存报告快照；概览与明细只供浏览。
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import { focusStepPrimaryAction } from "../../../step-task-card";
import { FullscreenPanel } from "../../../fullscreen-panel";
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
import { NetworkTrend } from "./network-trend";
import {
  ChartStory,
  LensNav,
  observationRequestKey,
  YearSelect,
  useVizLab,
  type Row,
  type VizStepState,
} from "./scaffold";

type Lens = "heat" | "network";

export const STEP10_DEFAULT_LENS: Lens = "heat";
export const STEP10_LENSES: { key: Lens; label: string; hint: string }[] = [
  { key: "heat", label: "两国行业比较", hint: "历年趋势 / 行业排名 / 两国同口径比较" },
  { key: "network", label: "贸易联系概览", hint: "国家间双边流向 · 补充探索" },
];
const STEP10_LENS_KEYS = STEP10_LENSES.map(({ key }) => key);

export function NetworkVizStep({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, pickCountries, schema } = useVizLab(
    meta, step, state, STEP10_DEFAULT_LENS, STEP10_LENS_KEYS,
  );
  const observations = (state.data?.observations ?? []).filter((item) => item.source === "explicit-network-trend" || item.source === "explicit-network-ranking");
  const picked = [...new Set(observations.map((item) => item.country))];
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [drill, setDrill] = useState(state.data?.drill ?? state.data?.compared?.at(-1) ?? fallbackDrill);
  const [heatSort, setHeatSort] = useState<HeatSortMetric>(
    normalizeHeatSortMetric(state.data?.heat_sort),
  );
  const [heatCoverage, setHeatCoverage] = useState<HeatCoverage>(
    normalizeHeatCoverage(state.data?.heat_coverage),
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
  const inspectCountry = (country: string) => {
    if (!meta.countries.includes(country)) return;
    drillTouched.current = true;
    setDrill(country);
    state.save({ drill: country });
  };
  const changeYear = (next: number) => {
    setYear(next);
  };
  const changeLens = (next: Lens) => {
    pickLens(next);
  };
  const retryHeat = () => {
    pageQuery.retry();
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
      <div className="controls" style={{ marginBottom: 12 }}>
        {lens === "network" && <YearSelect years={meta.years} year={year} onChange={changeYear} />}
        <span className="muted" style={{ fontSize: 12 }}>
          报告材料已记录 <b style={{ color: picked.length >= 2 ? "#159a86" : "#e0982a" }}>{picked.length}</b> 国{picked.length < 2 ? "（报告材料需 ≥2）" : ""}
        </span>
      </div>

      <LensNav<Lens> active={lens as Lens} onPick={changeLens} lenses={STEP10_LENSES.filter(({ key }) => key === "heat")} />

      {lens === "heat" && <NetworkTrend meta={meta} schema={schema} initialCountry={drill} observations={observations} syncing={state.syncing} syncError={state.syncError} onRetrySync={state.syncNow} onRecord={(countries, observations) => {
        pickCountries(countries);
        state.save({ compared: countries, metric: observations[0]?.metric, observations });
      }} />}
      <details open={lens === "network"} key={lens} className={lens === "heat" ? "technical-details" : undefined}>
      <summary hidden={lens === "network"}>查看行业明细表（可选）</summary>
      <FullscreenPanel
        title={`步骤 ${step.n} · ${countryLabel(drill)}行业网络指标表`}
        variant="heat"
        buttonLabel="全屏查看"
        enabled={lens === "heat"}
      >
        {lens === "heat" ? (
          <ChartStory
            eyebrow="国家×行业网络"
            title={`${countryLabel(drill)} 的行业节点网络指标(全球图上计算,按${heatSortLabel(heatSort)}显示${heatCoverageLabel(heatCoverage)})`}
            what={<>选一个国家，每行是一个行业节点。加权总度=入向+出向流量（正自环双计）；全正边二值介数把微小正边与大额边视为等长。可切换排序并查看 Top 15 或全部有限行业。</>}
            read={<>二值介数高只表示在这套全正边拓扑中，更多有向最短路径份额经过该节点；它不是流量大、经济枢纽或瓶颈的证明。对比加权总度与介数排序，观察流量规模和拓扑编码是否给出不同故事。</>}
            find={<>本表仅供查数，不参与报告材料收集。要保存比较，请回到上方行业图表，在报告材料卡中核对并保存。</>}
            note="指标在完整全球国家×行业图上计算，下钻只筛选展示行。当前没有边阈值敏感性分析，所以二值介数只作探索性拓扑基准；加权总度中的正自环在入向、出向各计一次。"
          >
            <div className="controls" style={{ marginBottom: 12 }}>
              <YearSelect years={meta.years} year={year} onChange={changeYear} />
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
              <span className="muted" role="note">明细仅供查阅；切换国家、年份和排序不会改变已保存材料。</span>
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
      </details>
      <details className="technical-details" key={`supplement-${lens}`} open={lens === "network"}>
        <summary>补充图表</summary>
        <LensNav<Lens> active={lens as Lens} onPick={(next) => {
          changeLens(next);
          requestAnimationFrame(() => focusStepPrimaryAction(document.querySelector(".content")));
        }} lenses={STEP10_LENSES.filter(({ key }) => key === "network")} />
      </details>
      <details className="technical-details" aria-label="步骤9完成清单">
        <summary>本步完成清单与口径说明</summary>
        <p>① {picked.length >= 2 ? "✓ 已记录至少两个经济体" : "待完成：记录两个经济体的比较"}</p>
        <p>② {observations.length ? "✓ 已保存行业指标读数" : "待完成：保存当前指标读数"}</p>
        <p>③ 在页面下方完成本步单选题。报告材料与答题分别检查。</p>
        <div className="controls"><button className="primary" onClick={() => changeLens("heat")}>前往行业图表，记录报告材料</button></div>
        <p className="muted">选择两个国家和一个指标 → 查看趋势或行业排名 → 在报告材料卡点击“保存为报告材料”，一次完成前两项；更换比较后可点击“更新报告材料”。贸易联系概览仅作补充探索。</p>
        <div className="tipbox">
          <b>两类图不能直接对应：</b>贸易联系概览以国家为节点，展示跨国中间品＋最终品流量，不含国内边，位置按预设地理区域排布。
          行业图表与<b>步骤 5 同源</b>，指标在完整国家×行业中间品网络上计算，包含国内联系和正自环。
          不要用概览中的位置解释某行业的中心性；国家级完全图的无权中心性没有区分度。
        </div>
      </details>
    </div>
  );
}
