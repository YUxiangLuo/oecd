/**
 * 步骤 8 · 生产可视化 —— 故事:「一国的增加值,有多深地进了 GVC?」
 *
 * 生产专属镜头:
 *   GVC 阶梯   把增加值拆成 纯国内 / 传统贸易 / 简单 GVC / 复杂 GVC 四段,越往右越深
 *   复杂排名   复杂 GVC 生产份额(3b/SVA)—— 深度分工的强度
 *   行业下钻   选一国看它各行业的生产构成,暴露一国内部的巨大异质性
 */
import { useEffect, useRef, useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { IndustryPage, Meta, Step, StepStateApi } from "../../../types";
import { CompositionBar, RankBarChart, countryLabel } from "../../../viz";
import { AsyncStateMessage, useAsync } from "../../shared";
import { ChartStory, LensNav, StepIntro, VizWorkbench, finiteBy, num, useCountryObservations, useVizLab, type Row, type VizStepState } from "./scaffold";

type Lens = "ladder" | "rank" | "industry";

const PROD_SEGMENTS = [
  { key: "1_VA_D", name: "纯国内" },
  { key: "2_VA_RT", name: "传统贸易" },
  { key: "3a_VA_GVC_S", name: "简单 GVC" },
  { key: "3b_VA_GVC_C", name: "复杂 GVC" },
];

export function Step9Production({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries } = useVizLab(
    meta, step, state, "ladder", ["ladder", "rank", "industry"],
  );
  const fallbackDrill = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const [drill, setDrill] = useState(state.data?.drill ?? state.data?.compared?.at(-1) ?? fallbackDrill);
  const drillTouched = useRef(Boolean(state.data));
  useEffect(() => {
    if (drillTouched.current || !state.data) return;
    const saved = state.data.drill ?? state.data.compared?.at(-1);
    if (saved && meta.countries.includes(saved)) setDrill(saved);
    drillTouched.current = true;
  }, [state.data, meta.countries]);
  const selectCountries = (next: string[]) => {
    pickCountries(next);
    const last = next.at(-1);
    if (last) {
      setDrill(last);
      state.save({ drill: last });
    }
  };
  const selectDrill = (next: string) => {
    drillTouched.current = true;
    setDrill(next);
    pickCountries(picked.includes(next) ? picked : [...picked, next]);
    state.save({ drill: next });
  };
  const countryQuery = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const industryQuery = useAsync<IndustryPage>(
    () => api.industryIndicatorsAll(year, drill),
    [lens, year, drill],
    { enabled: lens === "industry" && Boolean(drill) },
  );
  const rows = countryQuery.data ?? [];
  const page = industryQuery.data;
  useCountryObservations(rows, picked, year, "3b_VA_GVC_C_share", state);
  const highlight = new Set(picked);

  // 阶梯:主要经济体(按 SVA 取前 15)+ 你选中的国家,按复杂 GVC 份额排序 → 呈现梯度。
  const bySva = [...rows].sort((a, b) => num(b.SVA) - num(a.SVA));
  const ladderBase = bySva.slice(0, 15);
  const ladderRows = [...ladderBase, ...rows.filter((r) => picked.includes(String(r.country)) && !ladderBase.includes(r))];
  const rankRows = [...finiteBy(rows, "3b_VA_GVC_C_share")].sort((a, b) => num(b["3b_VA_GVC_C_share"]) - num(a["3b_VA_GVC_C_share"])).slice(0, 20);
  const industryRows = [...(page?.rows ?? [])].sort((a, b) => num(b.SVA) - num(a.SVA)).slice(0, 15);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 生产可视化`}
        lead="一个经济体的增加值，经过了哪些国内和跨境生产路径？"
        concept={step.concept}
        todo={[
          "在“选经济体”中选择至少两个对象进行对比",
          "查看 GVC 阶梯：四类构成中复杂 GVC 占多少",
          "用“行业下钻”观察一个经济体内部的行业差异",
        ]}
      />

      <LensNav<Lens>
        active={lens as Lens}
        onPick={pickLens}
        lenses={[
          { key: "ladder", label: "GVC 阶梯", hint: "四段生产构成" },
          { key: "rank", label: "复杂 GVC 排名", hint: "3b / SVA 份额" },
          { key: "industry", label: "行业下钻", hint: "一个经济体内部的行业差异" },
        ]}
      />

      <VizWorkbench
        years={meta.years} year={year} onYearChange={setYear}
        countries={meta.countries} picked={picked} onPick={selectCountries}
      >
      {lens === "industry" ? (
        <ChartStory
          eyebrow="经济体内部的行业差异"
          title={`${countryLabel(drill)} 各行业的生产构成（按 SVA 前 15）`}
          what={<>选择一个经济体，每条表示其中一个行业，并把增加值按纯国内、传统贸易、简单 GVC 和复杂 GVC 四类归一化到 100%。</>}
          read={<>同一经济体内，不同行业的复杂 GVC 份额可能差异很大；经济体汇总值不能代表每个行业。</>}
          find={<>找出复杂 GVC 份额最高和最低的行业，再切换经济体，比较同一行业的构成是否相似。</>}
          note="行业构成来自该行业的生产分解；行业差异说明后续回归为什么需要经济体×行业粒度。"
        >
          <div className="controls" style={{ marginBottom: 12 }}>
            <LabeledControl label="下钻经济体">
              {(id) => (
                <select id={id} value={drill} onChange={(e) => selectDrill(e.target.value)}>
                  {meta.countries.map((c) => <option key={c} value={c}>{countryLabel(c)}</option>)}
                </select>
              )}
            </LabeledControl>
          </div>
          {industryQuery.status === "loading" || industryQuery.status === "error" ? (
            <AsyncStateMessage
              status={industryQuery.status}
              error={industryQuery.error}
              loadingLabel={`加载 ${countryLabel(drill)} 行业指标中…`}
              onRetry={industryQuery.retry}
            />
          ) : industryRows.length ? (
              <CompositionBar rows={industryRows} segments={PROD_SEGMENTS} sortKey="3b_VA_GVC_C" sortLabel="复杂 GVC" sortFormat="amount" valueFormat="amount" />
            ) : <p className="muted">该经济体没有可展示的行业数据。</p>}
        </ChartStory>
      ) : countryQuery.status === "loading" || countryQuery.status === "error" ? (
        <AsyncStateMessage
          status={countryQuery.status}
          error={countryQuery.error}
          loadingLabel={`加载 ${year} 年经济体指标中…`}
          onRetry={countryQuery.retry}
        />
      ) : !rows.length ? (
        <p className="muted">该年份暂无经济体指标数据。</p>
      ) : lens === "ladder" ? (
        <ChartStory
          eyebrow="WWYZ 生产分解"
          title="GVC 阶梯：增加值经过哪些生产路径"
          what={<>每条表示一个经济体的总增加值 SVA，并按四类归一化：<b>纯国内</b>（不跨境）→ <b>传统贸易</b>（随最终品出口）→ <b>简单 GVC</b>（中间品跨境一次）→ <b>复杂 GVC</b>（至少两次跨境）。图表按复杂 GVC 份额排序。</>}
          read={<>复杂 GVC 部分越宽，经历多次跨境生产的增加值份额越高；纯国内部分越宽，只服务本地最终需求的份额越高。</>}
          find={<>查看所选经济体位于阶梯的什么位置，并用复杂 GVC 份额说明它与相邻经济体的差异。</>}
          note="展示总增加值前 15 的经济体以及你选择的对象；各条归一化到 100%，右侧数字为排序指标。"
        >
          <CompositionBar rows={ladderRows} segments={PROD_SEGMENTS} sortKey="3b_VA_GVC_C_share" sortLabel="复杂 GVC 份额" sortFormat="pct" valueFormat="amount" highlight={highlight} />
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="复杂分工强度"
          title="复杂 GVC 生产份额排名（前 20）"
          what={<>横条表示<b>复杂 GVC 增加值 / 总增加值</b>（3b / SVA）。复杂 GVC 指增加值至少两次跨境后才被最终吸收。</>}
          read={<>横条越长，经历多次跨境生产的增加值份额越高。这可能意味着政策暴露渠道更多，但是否更敏感必须由后续回归检验。</>}
          find={<>查看所选经济体与榜首的份额差距，并结合行业下钻判断汇总排名是否由少数行业推动。</>}
          note="仅展示前 20。"
        >
          <RankBarChart rows={rankRows} metricKey="3b_VA_GVC_C_share" label="复杂 GVC 份额" format="pct" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
