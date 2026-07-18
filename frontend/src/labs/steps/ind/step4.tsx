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
import { useState } from "react";
import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import { EvidencePanel } from "../../../step-evidence";
import type { IndicatorSchema, Meta, Step, StepEvidenceApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorEvidence } from "./indicator-table";

export function Step4Trade({ meta, step, evidence }: { meta: Meta; step: Step; evidence: StepEvidenceApi<IndicatorEvidence> }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState(meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const [page, setPage] = useState(1);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="把一国的出口拆开:钱到底从哪来?"
        concept={step.concept}
        todo={[
          "先看分解数据表:选个国家,读它各行业算出来的六项",
          "再用「动手拆解」挑一个出口,看六项精确加回毛出口(误差≈0)",
          "切换到第二个国家对比,留下学习证据",
        ]}
      />
      <EvidencePanel evidence={evidence} title="本步要留下的证据:在分解数据表里切换国家,看过至少两个实体" />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="WWZ 分解数据表(从 ICIO 算出来的)"
        what={<>这张表由步骤 1 的 <b>ICIO 表</b>(Z 中间投入、Y 最终需求)经 WWZ 总贸易核算法算出:每一行 = 某国某行业的出口,后面几列是拆出来的六项金额(DVAex / DVArt / DDC / FVA / FDC / taxsub,百万美元)。</>}
        read={<>怎么读一行:<b>DVAex</b> 越大 = 出口里越多是本国自己创造、被国外最终吸收的价值;<b>FVA</b> 越大 = 越依赖进口的外国中间品(后向 GVC)。列名旁的 ⓘ 可悬停看定义。</>}
        find={<>换个国家(下方筛选)看数字怎么变。这一步先把"算出来的数字"看明白,下一节再验证它们精确加回总量。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="trade" schema={schema} evidence={evidence}
          year={year} country={country} page={page}
          onYear={setYear} onCountry={setCountry} onPage={setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证 & 理解 · 挑一个拆开"
        title="动手拆解:六项精确加回毛出口"
        what={<>从上面的数据里挑一个出口(国家 / 行业),把它的毛出口拆成 WWZ 六项的<b>绝对金额</b>画成一条堆叠条,每一项都有释义。</>}
        read={<>盯住绿框那一行:<b>6 项加总 = 毛出口,误差 ≈ 0</b>——这就是"完全分解"的含义:没有价值被漏掉,也没有被重复算错。</>}
        find={<>点「查看 ICIO 计算示例」看一个 taxsub 为负的真实行业,这解释了为什么某些项会是负数;也可以勾选"双实体并排对比"直接比两个国家/行业。</>}
      >
        <DecompositionDemo
          step={4}
          meta={meta}
          onExampleChange={(exampleYear, exampleCountry) => {
            setYear(exampleYear);
            setCountry(exampleCountry);
            setPage(1);
          }}
        />
      </ChartStory>
    </div>
  );
}
