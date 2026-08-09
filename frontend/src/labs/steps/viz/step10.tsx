/**
 * 步骤 9 · 生产长度可视化 —— 故事:「生产链有多长,你在上游还是下游?」
 *
 * 长度专属镜头:
 *   上下游定位  前向 GVC 段长 × 后向 GVC 段长,象限区分上游 / 下游 / 长链 / 短链
 *   链长对比    前向 PLv 与后向 PLy 双条 + GVCPs 位置指数
 *   GVCPs 排名  位置指数 = 前向 / 后向 GVC 长度之比,>1 更靠上游
 */
import { api } from "../../../api";
import type { Meta, Step, StepStateApi } from "../../../types";
import { LengthViz, QuadrantScatter, RankBarChart } from "../../../viz";
import { AsyncStateMessage, useAsync } from "../../shared";
import { ChartStory, LensNav, StepIntro, VizWorkbench, finiteBy, num, useCountryObservations, useVizLab, type Row, type VizStepState } from "./scaffold";

type Lens = "position" | "bars" | "rank";

const POS_LABELS: [string, string, string, string] = [
  "长链 · 两端都深", "偏上游 · 前向长", "短链 · 靠近两端", "偏下游 · 后向长",
];

export function Step10Length({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<VizStepState> }) {
  const { year, setYear, lens, pickLens, picked, pickCountries } = useVizLab(
    meta, step, state, "position", ["position", "bars", "rank"],
  );
  const { data, error, status, retry } = useAsync<Row[]>(() => api.countryIndicators(year), [year]);
  const rows = data ?? [];
  useCountryObservations(rows, picked, year, "GVCPs", state);
  const highlight = new Set(picked);

  const posRows = finiteBy(rows, "PLv_GVC", "PLy_GVC");
  const rankRows = [...finiteBy(rows, "GVCPs")].sort((a, b) => num(b.GVCPs) - num(a.GVCPs)).slice(0, 20);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 生产长度可视化`}
        lead="生产链有多长？各经济体处于怎样的相对位置？"
        concept={step.concept}
        todo={[
          "在“选经济体”中选择至少两个对象进行对比",
          "在上下游定位图中判断它们的相对位置",
          "用 GVCPs 排名比较谁的前向 GVC 长度相对更长",
        ]}
      />

      <LensNav<Lens>
        active={lens as Lens}
        onPick={pickLens}
        lenses={[
          { key: "position", label: "上下游定位", hint: "前向 × 后向 GVC 段长" },
          { key: "bars", label: "链长对比", hint: "前向 PLv vs 后向 PLy" },
          { key: "rank", label: "GVCPs 排名", hint: "位置指数大于 1 表示相对更上游" },
        ]}
      />

      <VizWorkbench
        years={meta.years} year={year} onYearChange={setYear}
        countries={meta.countries} picked={picked} onPick={pickCountries}
      >
      {status === "loading" || status === "error" ? (
        <AsyncStateMessage
          status={status}
          error={error}
          loadingLabel={`加载 ${year} 年国家指标中…`}
          onRetry={retry}
        />
      ) : !rows.length ? (
        <p className="muted">该年份暂无经济体指标数据。</p>
      ) : lens === "position" ? (
        <ChartStory
          eyebrow="价值链位置"
          title="上下游定位：前向 GVC 段长 × 后向 GVC 段长"
          what={<>横轴是<b>后向 GVC 段长（PLy_GVC）</b>，从最终产品回溯到初始投入；纵轴是<b>前向 GVC 段长（PLv_GVC）</b>，从增加值来源看到最终吸收。虚线是全样本中位数。</>}
          read={<>位置越靠<b>左上</b>，前向长度相对更长、后向长度相对更短，因而位置相对更上游；越靠<b>右下</b>则相对更下游。两个方向都长表示跨境生产环节都较多。</>}
          find={<>找到所选经济体的位置，分别引用前向和后向长度说明判断；不要只凭经济体名称预设其上下游角色。</>}
          note={`参考线基于全部 ${posRows.length} 个有效样本；段长表示增加值被计为总产出的平均次数（WWYZ 2017b）。`}
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
          title="生产链长度对比（按前向总长度前 15）"
          what={<>每个经济体有两条：上条是<b>前向总长度（PLv）</b>，从增加值来源看到最终吸收；下条是<b>后向总长度（PLy）</b>，从最终产品回溯到初始投入。右侧显示 <b>GVCPs</b> 位置指数。</>}
          read={<>两条都较长表示两个方向经历的生产环节都较多。GVCPs 是前向与后向 GVC 长度之比，大于 1 表示相对更靠上游。</>}
          find={<>比较两个经济体的前向和后向长度，检查“总长度更长”是否也意味着“位置更上游”。</>}
          note="固定展示前向总长度前 15 的经济体；此视角用于总览，不随选择变化。"
        >
          <LengthViz rows={rows} />
        </ChartStory>
      ) : (
        <ChartStory
          eyebrow="上游度"
          title="GVC 位置指数 GVCPs 排名（前 20）"
          what={<>横条表示 <b>GVCPs = 前向 GVC 段长 / 后向 GVC 段长</b>。数值大于 1 表示前向长度相对更长，位置相对更上游。</>}
          read={<>横条越长，只能说明该经济体在这一指标下相对更靠上游；具体是资源供给、零部件生产还是其他角色，还需结合行业构成判断。</>}
          find={<>把所选经济体与榜首对象进行比较，并检查它们的行业构成是否支持相同的经济解释。</>}
          note="仅展示前 20；GVCPs 为无量纲比值。"
        >
          <RankBarChart rows={rankRows} metricKey="GVCPs" label="GVC 位置指数" format="number" highlight={highlight} />
        </ChartStory>
      )}
      </VizWorkbench>
    </div>
  );
}
