/**
 * 步骤 3 · 指标计算(贸易流)—— 故事:「把一国的出口拆开:钱到底从哪来?」
 *
 * 计算阶段的三段式(与可视化阶段刻意不同):
 *   讲什么/怎么来的  常驻教学:WWZ 分解是什么、怎么从 ICIO 的 Z/Y 算出来
 *   分解数据表        先出算好的数字(先算 → 再看),配“怎么读一行”引导
 *   动手拆解          保留的 DecompositionDemo,定位成“挑一个出口、验证六项精确加回总量”
 *
 * 与步骤 7-9 的分工:这里是单实体的绝对值 + 恒等式验证 + 逐项释义(理解与验证),
 * 步骤 7-9 是多国归一化对比(找规律)。
 */
import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function Step4Trade({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="把一个经济体的出口拆开：价值来自哪里？"
        concept={step.concept}
        todo={[
          "先看分解数据表：选择一个经济体，读取各行业的六项金额",
          "再用“动手拆解”选择一项出口，检查六项能否加回毛出口（误差≈0）",
          "切换经济体进行对比；当前选择会自动保存到实验记录",
        ]}
      />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="WWZ 分解数据表（由 ICIO 计算）"
        what={<>这张表由步骤 1 的 <b>ICIO 表</b>（Z 中间投入、Y 最终需求）按 WWZ 总贸易核算法计算。每一行表示某个经济体与行业的出口，后面六列是 DVAex、DVArt、DDC、FVA、FDC 和 taxsub 的金额，单位为百万美元。</>}
        read={<>金额用于核对出口价值如何分解：<b>DVAex</b> 是被外国最终吸收的本国增加值，<b>FVA</b> 是出口中的外国增加值。判断出口对外国投入的依赖程度时应比较 <b>FVA 份额</b>；不能只看 FVA 金额，因为金额还受出口规模影响。列名旁的 ⓘ 可悬停查看定义。</>}
        find={<>切换经济体，观察金额与份额是否给出相同排序；再到下一节检查六项能否精确加回毛出口。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="trade" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证与理解 · 选择一项拆开"
        title="动手拆解：六项精确加回毛出口"
        what={<>从上表选择一个经济体与行业，把毛出口拆成 WWZ 六项<b>绝对金额</b>并画成堆叠条，每一项都有释义。</>}
        read={<>查看绿框中的恒等式：<b>六项加总 = 毛出口，误差 ≈ 0</b>。这就是“完全分解”的含义：全部出口价值都被纳入，分解项不会遗漏。</>}
        find={<>打开“查看 ICIO 计算示例”，观察 taxsub 为负的行业；也可以启用“双实体并排对比”，比较两个经济体或行业。</>}
      >
        <DecompositionDemo
          step={4}
          meta={meta}
          primaryYear={controls.year}
          primaryCountry={controls.country}
          onPrimaryChange={controls.setPrimary}
        />
      </ChartStory>
    </div>
  );
}
