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
        lead="一国的增加值,有多深地进了 GVC?"
        concept={step.concept}
        todo={[
          "在「选国家」里挑至少两个经济体对比",
          "看 GVC 阶梯:四段构成里复杂 GVC 占多少",
          "用「行业下钻」看一国内部各行业差别有多大",
        ]}
      />

      <VizWorkbench
        title={`步骤 ${step.n} · GVC 生产指标可视化`}
        toolbar={(
          <LensNav<Lens>
            active={lens as Lens}
            onPick={pickLens}
            lenses={[
              { key: "ladder", label: "GVC 阶梯", hint: "四段生产构成" },
              { key: "rank", label: "复杂 GVC 排名", hint: "3b / SVA 份额" },
              { key: "industry", label: "行业下钻", hint: "一国内部各行业差别" },
            ]}
          />
        )}
        years={meta.years} year={year} onYearChange={setYear}
        countries={meta.countries} picked={picked} onPick={selectCountries}
      >
      {lens === "industry" ? (
        <ChartStory
          eyebrow="一国内部的异质性"
          title={`${countryLabel(drill)} 各行业的生产构成(按 SVA 前 15)`}
          what={<>选一个国家,每条 = 它的一个行业,增加值按四段(纯国内 / 传统 / 简单 / 复杂 GVC)归一化到 100%。</>}
          read={<>同一个国家的不同行业可能有很不同的复杂 GVC 份额；国家总量会掩盖这种行业异质性。</>}
          find={<>找出该国复杂 GVC 最深的几个行业;再换一个国家(下方下拉),对比同一行业在不同国家的深度。</>}
          note="行业级构成 = 该行业的生产分解；国家–行业级分析可以保留国家汇总会掩盖的异质性。"
        >
          <div className="controls" style={{ marginBottom: 12 }}>
            <LabeledControl label="下钻国家">
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
            ) : <p className="muted">该国无行业数据。</p>}
        </ChartStory>
      ) : countryQuery.status === "loading" || countryQuery.status === "error" ? (
        <AsyncStateMessage
          status={countryQuery.status}
          error={countryQuery.error}
          loadingLabel={`加载 ${year} 年国家指标中…`}
          onRetry={countryQuery.retry}
        />
      ) : !rows.length ? (
        <p className="muted">该年份暂无国家指标数据。</p>
      ) : lens === "ladder" ? (
        <ChartStory
          eyebrow="WWYZ 生产分解"
          title="GVC 阶梯:增加值走到哪一步"
          what={<>每条 = 一个国家的总增加值 SVA,按四段归一化:<b>纯国内</b>(不跨境)→ <b>传统贸易</b>(随最终品出一次境)→ <b>简单 GVC</b>(中间品跨一次)→ <b>复杂 GVC</b>(至少两次跨境)。按复杂 GVC 份额排序。</>}
          read={<>从上到下,右端的红/橙段(GVC 段)越来越宽 = 更多增加值通过跨境生产路径实现。纯国内段宽 = 更多增加值沿不跨境路径满足本国最终需求，不等同于整个经济体自给。</>}
          find={<>小型开放经济体(如卢森堡、斯洛伐克)复杂 GVC 段最宽;大型经济体纯国内段更厚。看你选的国家排在阶梯哪一档。</>}
          note="展示总增加值前 15 的经济体 + 你选中的国家;归一化到 100%,右侧数字为该国排序指标。"
        >
          <CompositionBar rows={ladderRows} segments={PROD_SEGMENTS} sortKey="3b_VA_GVC_C_share" sortLabel="复杂 GVC 份额" sortFormat="pct" valueFormat="amount" highlight={highlight} />
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="复杂分工强度"
          title="复杂 GVC 生产份额排名(前 20)"
          what={<>横条 = <b>复杂 GVC 增加值 / 总增加值</b>(3b / SVA)。复杂 = 增加值至少两次跨越国境才被最终吸收。</>}
          read={<>越长 = 复杂 GVC 增加值份额越高。它可能面临更多跨境政策暴露，但是否表现出更强响应要由后续回归和识别假设检验。</>}
          find={<>榜首多是深度融入区域生产网络的中小经济体;你选的国家高亮为红色,看它离榜首有多远。</>}
          note="仅展示前 20。"
        >
          <RankBarChart rows={rankRows} metricKey="3b_VA_GVC_C_share" label="复杂 GVC 份额" format="pct" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
