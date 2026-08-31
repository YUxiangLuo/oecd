/**
 * 步骤 3 · 指标计算(贸易流)—— 故事:「把一国的出口拆开:钱到底从哪来?」
 *
 * 计算阶段的三段式(与可视化阶段刻意不同):
 *   讲什么/怎么来的  常驻教学:WWZ 聚合项与 OECD TLS 扩展、怎么从 ICIO 算出来
 *   分解数据表        先出算好的数字(先算 → 再看),配“怎么读一行”引导
 *   动手拆解          保留的 DecompositionDemo,定位成“挑一个出口、验证五类聚合项加 TLS 扩展精确加回总量”
 *
 * 与步骤 7-9 的分工:这里是单实体的绝对值 + 恒等式验证 + 逐项释义(理解与验证),
 * 步骤 7-9 是多国归一化对比(找规律)。
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
        title="WWZ 聚合项与 TLS 扩展数据表(从 ICIO 算出来的)"
        what={<>这张表由步骤 1 的 <b>ICIO 表</b>算出:每一行 = 某国某行业的出口。WWZ 的 16 个明细项归并为 DVAex / DVArt / DDC / FVA / FDC 五类；taxsub 是由 OECD ICIO 的 TLS 账户计算的扩展项,用于匹配 VA+TLS 账户闭合毛出口口径，不是 WWZ 原文分类；TLS 是产品税减补贴账户，不等于步骤 11 的额外关税。</>}
        read={<>怎么读一行:<b>DVAex / FVA 金额</b>先说明该行业的出口规模构成；跨国家或行业判断本国增加值构成、后向依赖时，应分别比较 <b>DVAex_share / 课程 FVA_share</b>，不能只用绝对金额。FVA 包含直接与间接外国上游纯增加值，TLS 单列，所以该份额不是 OECD EXGR_FVASH。列名旁的 ⓘ 可悬停看定义。</>}
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
        find={<>点「查看 ICIO 计算示例」看一个 taxsub 为负的真实行业,这解释了为什么某些项会是负数;也可以勾选"双实体并排对比"直接比两个国家/行业。</>}
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
