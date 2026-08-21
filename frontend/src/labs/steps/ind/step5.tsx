/**
 * 步骤 4 · 指标计算(生产)—— 故事:「一国的增加值,有多深地进了全球分工?」
 *
 * 与步骤 3 同为计算阶段三段式:讲清 → 分解数据表(先出数字)→ 动手拆解(验证四段
 * 精确加回总增加值 SVA)。保留 DecompositionDemo。
 */
import { api } from "../../../api";
import { explicitDemoCountry } from "../../../decomposition-model";
import { DecompositionDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function Step5Production({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="一国的增加值,有多深地进了全球分工?"
        concept={step.concept}
        todo={[
          "先看生产分解表:读 SVA、四段增加值与复杂 GVC 份额(3b/SVA)",
          "再用「动手拆解」挑一个,看四段精确加回总增加值 SVA(误差≈0)",
          "切换国家进行对比；当前选择会自动保存到实验记录",
        ]}
      />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="WWYZ 生产分解表(从 ICIO 算出来的)"
        what={<>由步骤 1 的 <b>ICIO 表</b>经 WWYZ 算法算出:每行某国某行业的总增加值 <b>SVA</b>,按去向拆成四段——纯国内(1_VA_D)、传统贸易(2_VA_RT)、简单 GVC(3a)、复杂 GVC(3b),金额百万美元。</>}
        read={<>默认列依次给出 <b>SVA、1_VA_D、2_VA_RT、3a_VA_GVC_S、3b_VA_GVC_C</b> 与 <b>3b / SVA</b>。四段绝对金额先反映生产规模，跨实体比较复杂 GVC 深度要看份额；纯国内份额高不等同于整个经济体“自给”。</>}
        find={<>换个国家并比较 <b>3b / SVA</b>，观察开放程度与复杂 GVC 构成是否相关；下一节验证四段精确加回 SVA。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="production" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证 & 理解 · 挑一个拆开"
        title="动手拆解:四段精确加回总增加值"
        what={<>挑一个实体(国家 / 行业),把它的总增加值 SVA 拆成四段的<b>绝对金额</b>画成堆叠条,每段都有释义。</>}
        read={<>盯住绿框那一行:<b>四段加总 = SVA,误差 ≈ 0</b>——增加值被完整地归到四条实现路径上,没有遗漏。</>}
        find={<>勾选"双实体并排对比",直接比两个国家/行业的四段构成谁更"复杂 GVC"。</>}
      >
        <DecompositionDemo
          step={5}
          meta={meta}
          primaryYear={controls.year}
          primaryCountry={explicitDemoCountry(meta.countries, controls.country)}
          onPrimaryChange={controls.setPrimary}
        />
      </ChartStory>
    </div>
  );
}
