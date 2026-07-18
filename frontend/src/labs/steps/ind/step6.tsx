/**
 * 步骤 5 · 指标计算(长度)—— 故事:「增加值走一趟生产,平均经过几道工序?」
 *
 * 计算阶段三段式:讲清 → 分解数据表 → 动手拆解(验证各段“VA份额×段长度”的贡献
 * 加权加总 = 总长度)。长度是加权口径,恒等式比 4/5 略微含蓄。
 */
import { useState } from "react";
import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import { EvidencePanel } from "../../../step-evidence";
import type { IndicatorSchema, Meta, Step, StepEvidenceApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorEvidence } from "./indicator-table";

export function Step6Length({ meta, step, evidence }: { meta: Meta; step: Step; evidence: StepEvidenceApi<IndicatorEvidence> }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState(meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const [page, setPage] = useState(1);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="增加值走一趟生产,平均经过几道工序?"
        concept={step.concept}
        todo={[
          "先看长度分解表:选个国家,读前向 PLv、后向 PLy 与位置 GVCPs",
          "再用「动手拆解」看各段按 VA 份额加权后精确加回总长度",
          "切换到第二个国家对比,留下学习证据",
        ]}
      />
      <EvidencePanel evidence={evidence} title="本步要留下的证据:在长度分解表里切换国家,看过至少两个实体" />

      <ChartStory
        eyebrow="计算结果 · 先出数字"
        title="生产长度分解表(从 ICIO 算出来的)"
        what={<>由步骤 1 的 <b>ICIO 表</b>算出的生产长度:<b>PLv</b>(前向,增加值到最终吸收平均经过几道生产环节)、<b>PLy</b>(后向,最终品回溯到初始投入)、<b>GVCPs</b>(价值链位置)。</>}
        read={<>怎么读一行:PLv / PLy 通常在 2–4 之间,表示增加值平均被计为总产出 2–4 次;<b>GVCPs &gt; 1</b> = 更靠<b>上游</b>(离最终需求远,如资源型经济体)。</>}
        find={<>换个国家看数字怎么变。资源与原材料供应型经济体的 GVCPs 通常较高;下一节验证各段加权后加回总长度。</>}
      >
        <IndicatorTable
          meta={meta} groupKey="length" schema={schema} evidence={evidence}
          year={year} country={country} page={page}
          onYear={setYear} onCountry={setCountry} onPage={setPage}
        />
      </ChartStory>

      <ChartStory
        eyebrow="验证 & 理解 · 挑一个拆开"
        title="动手拆解:各段加权后加回总长度"
        what={<>挑一个实体,把前向总长度 PLv 拆成三段(纯国内 / 传统 / GVC);每段显示的是<b>"VA 份额 × 段长度"的贡献值</b>,不是段长度本身。</>}
        read={<>盯住绿框:<b>各段贡献加总 = 总长度,误差 ≈ 0</b>——总长度是段长度按增加值份额的<b>加权平均</b>(WWYZ 2017b),不是简单相加。</>}
        find={<>注意 GVC 段通常最长(增加值多次被计为产出);GVCPs = 前向 GVC 段 / 后向 GVC 段。</>}
      >
        <DecompositionDemo
          step={6}
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
