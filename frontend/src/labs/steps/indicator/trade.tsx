/**
 * 步骤 2 · 指标计算(贸易流)—— 故事:「把一国的出口拆开:钱到底从哪来?」
 *
 * 计算阶段的三段式(与可视化阶段刻意不同):
 *   讲什么/怎么来的  常驻教学:WWZ 聚合项与 OECD TLS 扩展、怎么从 ICIO 算出来
 *   分解数据表        先出算好的数字(先算 → 再看),配“怎么读一行”引导
 *   动手拆解          保留的 DecompositionDemo,定位成“挑一个出口、验证五类聚合项加 TLS 扩展精确加回总量”
 *
 * 与步骤 6-8 的分工:这里是单实体的绝对值 + 恒等式验证 + 逐项释义(理解与验证),
 * 步骤 6-8 是多国归一化对比(找规律)。
 */
import { api } from "../../../api";
import { explicitDemoCountry } from "../../../decomposition-model";
import { DecompositionDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function TradeIndicatorStep({ meta, step: _step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="出口价值构成：读懂每个分项"
        what={<>这张表由步骤 1 的<b>投入产出表</b>算出，每一行对应某国某行业的出口。各分项区分国内增加值、外国增加值、重复计算和税收减补贴。</>}
        read={<>金额告诉我们这一项有多大，占比告诉我们它在出口中占多少。<b>外国增加值项占比</b>观察的是出口分解中的外国增加值这一项；后续用它作为贸易构成的代表指标。跨国家或行业比较构成时，不能只看金额。列名旁的 ⓘ 可查看完整定义与计算口径。</>}
        find={<>换个国家(下方筛选)看数字怎么变。这一步先把"算出来的数字"看明白,下一节再验证它们精确加回总量。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="trade" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证 & 理解 · 挑一个拆开"
        title="动手拆解:五类 WWZ 聚合项 + TLS 扩展精确加回毛出口"
        what={<>从上面的数据里挑一个出口(国家 / 行业),把 VA+TLS 账户闭合毛出口拆成五类 WWZ 聚合项和一个 TLS 扩展项的<b>绝对金额</b>画成堆叠条,每一项都有释义。</>}
        read={<>盯住绿框那一行:<b>五类 WWZ 聚合项 + TLS 扩展 = VA+TLS 账户闭合毛出口，误差 ≈ 0</b>。DDC / FDC 本来就是重复计算类别；闭合本身不能证明源数据和算法没有其他错误。</>}
        find={<>DDC/FDC 的极小负数可能来自浮点舍入，超过容差应追溯源账户与计算；重复计算项不是为闭合而相减的负项。taxsub 为负可表示沿供应链累计后的净补贴(列 tooltip 有完整释义);也可以勾选"双实体并排对比"直接比两个国家/行业。</>}
      >
        <DecompositionDemo
          step={4}
          meta={meta}
          primaryYear={controls.year}
          primaryCountry={explicitDemoCountry(meta.countries, controls.country)}
          onPrimaryChange={controls.setPrimary}
        />
      </ChartStory>
    </div>
  );
}
