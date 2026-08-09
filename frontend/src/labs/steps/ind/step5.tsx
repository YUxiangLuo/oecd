/**
 * 步骤 4 · 指标计算(生产)—— 故事:「一国的增加值,有多深地进了全球分工?」
 *
 * 与步骤 3 同为计算阶段三段式:讲清 → 分解数据表(先出数字)→ 动手拆解(验证四段
 * 精确加回总增加值 SVA)。保留 DecompositionDemo。
 */
import { api } from "../../../api";
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
        lead="一个经济体的增加值，经过了怎样的生产路径？"
        concept={step.concept}
        todo={[
          "先看生产分解表：默认核心列同时展示复杂 GVC 金额与份额；展开后可查看完整分解",
          "再用“动手拆解”选择一项，检查四类能否加回总增加值 SVA（误差≈0）",
          "切换经济体进行对比；当前选择会自动保存到实验记录",
        ]}
      />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="WWYZ 生产分解表（由 ICIO 计算）"
        what={<>这张表由步骤 1 的 <b>ICIO 表</b>按 WWYZ 方法计算。每一行表示某个经济体与行业的总增加值 <b>SVA</b>。默认核心列突出纯国内、传统贸易与复杂 GVC 的金额及复杂 GVC 份额；点击“展开扩展指标”可查看简单 GVC 等完整分解。金额单位为百万美元。</>}
        read={<>金额用于核对增加值如何分解。判断生产结构时应比较各类占 SVA 的<b>份额</b>：复杂 GVC 份额较高表示更多增加值经历多次跨境生产；不能只凭复杂 GVC 金额判断嵌入程度，因为金额还受经济规模影响。</>}
        find={<>切换经济体，比较复杂 GVC 金额与份额的排序是否一致；再到下一节检查四类能否精确加回 SVA。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="production" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证与理解 · 选择一项拆开"
        title="动手拆解：四类精确加回总增加值"
        what={<>选择一个经济体与行业，把总增加值 SVA 拆成四类<b>绝对金额</b>并画成堆叠条，每一类都有释义。</>}
        read={<>查看绿框中的恒等式：<b>四类加总 = SVA，误差 ≈ 0</b>。这表示增加值已完整归入四种实现路径。</>}
        find={<>启用“双实体并排对比”，先比较四类金额，再结合份额判断两个经济体或行业的生产结构差异。</>}
      >
        <DecompositionDemo
          step={5}
          meta={meta}
          primaryYear={controls.year}
          primaryCountry={controls.country}
          onPrimaryChange={controls.setPrimary}
        />
      </ChartStory>
    </div>
  );
}
