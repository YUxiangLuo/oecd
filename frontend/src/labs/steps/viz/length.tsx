/**
 * 步骤 8 · 生产长度可视化 —— 故事:「生产链有多长,你在上游还是下游?」
 *
 * 长度专属镜头:
 *   上下游定位  前向 GVC 段长 × 后向 GVC 段长,象限区分上游 / 下游 / 长链 / 短链
 *   链长对比    前向 PLv 与后向 PLy 双条 + GVCPs 位置指数
 *   GVCPs 排名  位置指数 = 前向 / 后向 GVC 长度之比,>1 更靠上游
 *   行业下钻    单一国家内部的行业 PLv_GVC × PLy_GVC 长度位置
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { IndicatorSchema, IndustryPage, Meta, Step, StepStateApi } from "../../../types";
import { LengthViz, QuadrantScatter, RankBarChart, countryLabel, topWithSelected } from "../../../viz";
import { AsyncStateMessage, useAsync } from "../../shared";
import { ChartStory, LensNav, VizWorkbench, finiteBy, observationRequestKey, useCountryIndicatorRows, useCountryObservations, useVizLab, type Row, type VizStepState } from "./scaffold";

type Lens = "position" | "bars" | "rank" | "industry";

const POS_LABELS: [string, string, string, string] = [
  "长链 · 两端都深", "偏上游 · 前向长", "短链 · 靠近两端", "偏下游 · 后向长",
];

export const LENGTH_AXIS_FALLBACK = {
  forward: "从增加值创造端向最终吸收端追踪：GVC 活动诱发的累计总产出除以关联增加值。VA 为正时表示增加值加权平均生产阶段数；存在负 VA 时是有符号账户比值，不保证普通加权平均的区间性质；不是跨境次数、经过国家数或网络边数。",
  backward: "从最终品端向初始增加值来源回溯：GVC 活动累计总产出除以最终产品承载的关联增加值。VA 为正时表示增加值加权平均生产阶段数；存在负 VA 时是有符号账户比值；不是跨境次数、经过国家数或网络边数。",
} as const;

export function lengthAxisDefinitions(schema?: IndicatorSchema | null) {
  return {
    forward: schema?.fields.PLv_GVC?.desc || LENGTH_AXIS_FALLBACK.forward,
    backward: schema?.fields.PLy_GVC?.desc || LENGTH_AXIS_FALLBACK.backward,
  };
}

export function restoreLengthDrill(countries: readonly string[], saved?: VizStepState): string {
  const candidates = [saved?.drill, saved?.compared?.at(-1), "CHN", countries[0]];
  return candidates.find((country): country is string => typeof country === "string" && countries.includes(country)) ?? "";
}

export function finiteIndustryLengthRows(page: IndustryPage | null | undefined): Row[] {
  return finiteBy((page?.rows ?? []) as Row[], "PLv_GVC", "PLy_GVC");
}

export function gvcPositionRankRows(rows: readonly Row[], selected: Iterable<string>): Row[] {
  return topWithSelected(rows, "GVCPs", 20, selected);
}

export function lengthIndustryRequestKey(meta: Pick<Meta, "dataset">, year: number, country: string): string | null {
  return country ? observationRequestKey(meta, year, "country-industry", country) : null;
}

export function LengthVizStep({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries, schema } = useVizLab(
    meta, step, state, "position", ["position", "bars", "rank", "industry"],
  );
  const [drill, setDrill] = useState(() => restoreLengthDrill(meta.countries, state.data));
  const drillTouched = useRef(false);
  useEffect(() => {
    if (drillTouched.current || !state.data) return;
    setDrill(restoreLengthDrill(meta.countries, state.data));
    drillTouched.current = true;
  }, [state.data, meta.countries]);
  const selectDrill = (country: string) => {
    if (!meta.countries.includes(country)) return;
    drillTouched.current = true;
    setDrill(country);
    state.save({ drill: country });
  };
  const countryQuery = useCountryIndicatorRows(meta, year);
  const { rows, error, status, retry } = countryQuery;
  const industryEnabled = lens === "industry" && meta.countries.includes(drill);
  const industryKey = lengthIndustryRequestKey(meta, year, drill) ?? `missing-release:${year}:country-industry:${drill}`;
  const industryQuery = useAsync<IndustryPage>(
    () => api.industryIndicatorsAll(year, drill),
    [year, drill],
    { enabled: industryEnabled, requestKey: industryKey },
  );
  useCountryObservations(countryQuery.response, countryQuery.identity, picked, "GVCPs", state);
  const highlight = new Set(picked);

  const posRows = finiteBy(rows, "PLv_GVC", "PLy_GVC");
  const lengthDefinitions = lengthAxisDefinitions(schema);
  const rankRows = gvcPositionRankRows(rows, picked);
  const industryRows = finiteIndustryLengthRows(industryQuery.data);

  return (
    <div>
      <VizWorkbench
        title={`步骤 ${step.n} · GVC 长度指标可视化`}
        toolbar={(
          <LensNav<Lens>
            active={lens as Lens}
            onPick={pickLens}
            lenses={[
              { key: "position", label: "上下游定位", hint: "前向 × 后向 GVC 段长" },
              { key: "bars", label: "链长对比", hint: "前向 PLv vs 后向 PLy" },
              { key: "rank", label: "GVCPs 排名", hint: "位置指数,>1 更上游" },
              { key: "industry", label: "行业下钻", hint: "一国内部各行业的前向 × 后向 GVC 段长" },
            ]}
          />
        )}
        years={meta.years} year={year} onYearChange={setYear}
        countries={meta.countries} picked={picked} onPick={pickCountries}
      >
      {lens === "industry" ? (
        <ChartStory
          eyebrow="国家–行业长度异质性"
          title={`${countryLabel(drill)} 各行业的上下游长度位置`}
          what={<>每个点是该国一个行业；横轴为后向 GVC 段长 PLy_GVC，纵轴为前向 GVC 段长 PLv_GVC，单位均为生产阶段账户比值；VA 为正时可作增加值加权平均理解，存在负 VA 时是有符号加权。</>}
          read={<>橙色 y=x 线上方表示前向段相对更长、位置更偏上游；线下方表示后向段相对更长。该位置不是跨境次数、经过国家数或网络边数。</>}
          find={<>切换下钻国家，比较同一经济体内部哪些行业更偏上游或下游；国家总量会掩盖这种行业异质性。</>}
          note={`仅绘制 ${year} 年 PLv_GVC 与 PLy_GVC 均为有限值的行业；当前有效行业 n=${industryRows.length}。`}
        >
          <div className="controls" style={{ marginBottom: 12 }}>
            <LabeledControl label="下钻国家">
              {(id) => (
                <select id={id} value={drill} onChange={(event) => selectDrill(event.target.value)}>
                  {meta.countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}
                </select>
              )}
            </LabeledControl>
          </div>
          {industryQuery.status === "loading" || industryQuery.status === "idle" || industryQuery.status === "error" ? (
            <AsyncStateMessage
              status={industryQuery.status}
              error={industryQuery.error}
              loadingLabel={`加载 ${year} 年 ${countryLabel(drill)} 行业长度指标中…`}
              onRetry={industryQuery.retry}
            />
          ) : industryRows.length === 0 ? (
            <p className="muted" role="status">{year} 年 {countryLabel(drill)} 没有同时具备 PLv_GVC 与 PLy_GVC 的行业数据。</p>
          ) : (
            <QuadrantScatter
              rows={industryRows}
              referenceRows={industryRows}
              xKey="PLy_GVC" yKey="PLv_GVC"
              xLabel="行业后向 GVC 段长(→下游)" yLabel="行业前向 GVC 段长(→上游)"
              xFormat="number" yFormat="number"
              quadrantLabels={POS_LABELS}
              equalityLine
            />
          )}
        </ChartStory>
      ) : status === "loading" || status === "error" ? (
        <AsyncStateMessage
          status={status}
          error={error}
          loadingLabel={`加载 ${year} 年国家指标中…`}
          onRetry={retry}
        />
      ) : !rows.length ? (
        <p className="muted">该年份暂无国家指标数据。</p>
      ) : lens === "position" ? (
        <ChartStory
          eyebrow="价值链位置"
          title="上下游定位:前向 GVC 段长 × 后向 GVC 段长"
          what={<>横轴 <b>后向 GVC 段长 PLy_GVC</b>：{lengthDefinitions.backward} 纵轴 <b>前向 GVC 段长 PLv_GVC</b>：{lengthDefinitions.forward} 虚线是全样本中位数。</>}
          read={<>越靠<b>左上</b>(前向长、后向短)= 在该口径下越<b>上游</b>(离最终需求更远);越靠<b>右下</b> = 相对更下游。上游既可能是原材料，也可能是关键中间品或生产性服务。</>}
          find={<>先看你选的国家相对位置，再切到「行业下钻」查看同一国家各行业的 PLv_GVC × PLy_GVC。国家位置是多种行业活动的加权结果，不能直接等同于“资源国”或“组装国”。</>}
          note={`参考线基于全部有效样本 n=${posRows.length}；段长是累计总产出/关联增加值的账户比值；VA 为正时可理解为增加值加权阶段数，负 VA 时是有符号加权；不是跨境次数或国家数（WWYZ 2017b）。`}
        >
          <QuadrantScatter
            rows={posRows} referenceRows={posRows}
            xKey="PLy_GVC" yKey="PLv_GVC"
            xLabel="后向 GVC 段长(→下游)" yLabel="前向 GVC 段长(→上游)"
            xFormat="number" yFormat="number"
            highlight={highlight} quadrantLabels={POS_LABELS}
            equalityLine
          />
        </ChartStory>
      ) : lens === "bars" ? (
        <ChartStory
          eyebrow="前向 vs 后向"
          title="生产链长度对比(前向总长度前 15 + 已选国家)"
          what={<>每个国家两条:上条 <b>前向总长度 PLv</b>(增加值 → 最终吸收),下条 <b>后向总长度 PLy</b>(最终品 → 初始投入);右侧是 <b>GVCPs</b> 位置指数。</>}
          read={<>两条都长 = 生产环节多、辗转深。GVCPs = 前向 / 后向 GVC 段之比,&gt;1 表示更靠上游。</>}
          find={<>在同一年、同一粒度内对比不同经济体的链长；数值表示增加值平均被计为总产出的次数，不预设固定范围。</>}
          note="展示前向总长度前 15 + 已选国家；已选国家只扩展当前显示，不改变保存的国家观测值。"
        >
          <LengthViz rows={rows} highlight={highlight} />
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="上游度"
          title="GVC 位置指数 GVCPs 排名(前 20 + 已选国家)"
          what={<>横条 = <b>GVCPs = 前向 GVC 段长 / 后向 GVC 段长</b>，按有限值取前 20，并追加你主动选择但未进入前 20 的国家。&gt;1 = 前向更长 = 更靠<b>上游</b>(离最终需求远)。</>}
          read={<>比值越高 = 前向 GVC 段相对后向段更长、离最终需求相对更远；它不告诉你上游活动究竟是原材料、零部件还是服务。</>}
          find={<>把你选的国家与榜首比较，再切到本步「行业下钻」检查行业级长度位置；不要仅凭一个国家级比值贴标签。</>}
          note="展示前 20 + 已选国家；GVCPs 为无量纲相对位置指标，显示扩展不改变保存的观测，也不是资源禀赋或产业类型分类器。"
        >
          <RankBarChart rows={rankRows} metricKey="GVCPs" label="GVC 位置指数" format="number" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
