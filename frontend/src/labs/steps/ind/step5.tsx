/**
 * 步骤 5 · 指标计算(生产)—— 故事:「一国的增加值,有多深地进了全球分工?」
 *
 * 与步骤 4 同为计算阶段三段式:讲清 → 分解数据表(先出数字)→ 动手拆解(验证四段
 * 精确加回总增加值 SVA)。保留 DecompositionDemo。
 */
import { useState } from "react";
import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import { EvidencePanel } from "../../../step-evidence";
import type { IndicatorSchema, Meta, Step, StepEvidenceApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorEvidence } from "./indicator-table";

export function Step5Production({ meta, step, evidence }: { meta: Meta; step: Step; evidence: StepEvidenceApi<IndicatorEvidence> }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState(meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const [page, setPage] = useState(1);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker="步骤 5 · 指标计算"
        lead="一国的增加值,有多深地进了全球分工?"
        concept={step.concept}
        todo={[
          "先看生产分解表:选个国家,读它各行业的四段增加值",
          "再用「动手拆解」挑一个,看四段精确加回总增加值 SVA(误差≈0)",
          "切换到第二个国家对比,留下学习证据",
        ]}
      />
      <EvidencePanel evidence={evidence} title="本步要留下的证据:在生产分解表里切换国家,看过至少两个实体" />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="WWYZ 生产分解表(从 ICIO 算出来的)"
        what={<>由步骤 1 的 <b>ICIO 表</b>经 WWYZ 算法算出:每行某国某行业的总增加值 <b>SVA</b>,按去向拆成四段——纯国内(1_VA_D)、传统贸易(2_VA_RT)、简单 GVC(3a)、复杂 GVC(3b),金额百万美元。</>}
        read={<>怎么读一行:<b>复杂 GVC(3b)</b> 越大 = 增加值跨越了越多次国境、越深地嵌入全球生产网络;<b>纯国内</b> 越大 = 越靠内需自给。</>}
        find={<>换个国家看数字怎么变。小型开放经济体(如新加坡、卢森堡)的复杂 GVC 通常占比更高;下一节验证四段精确加回 SVA。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="production" schema={schema} evidence={evidence}
          year={year} country={country} page={page}
          onYear={setYear} onCountry={setCountry} onPage={setPage}
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
