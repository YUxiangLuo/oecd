/**
 * 步骤 6 · 指标计算(网络)—— 故事:「把经济当成一张网:谁是枢纽?」
 *
 * 网络没有加总恒等式,所以顺序与 3/4/5 相反:先用小网络建立“度 / 介数是怎么数出来
 * 的”直觉,再看真实的全球国家×行业中心性表(否则一堆抽象数字看不懂)。
 * 保留 NetworkCentralityDemo(合成小图)。中心性只在国家–行业级有意义(国家图是
 * 完全图、介数恒为 0,见 country_degenerate 与步骤 10)。
 */
import { useState } from "react";
import { api } from "../../../api";
import { NetworkCentralityDemo } from "../../../demos";
import { EvidencePanel } from "../../../step-evidence";
import type { IndicatorSchema, Meta, Step, StepEvidenceApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorEvidence } from "./indicator-table";

export function Step7Network({ meta, step, evidence }: { meta: Meta; step: Step; evidence: StepEvidenceApi<IndicatorEvidence> }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const [country, setCountry] = useState(meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const [page, setPage] = useState(1);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="把经济当成一张网:谁是枢纽?"
        concept={step.concept}
        todo={[
          "先在小网络上看懂度 / 介数中心性是怎么数出来的",
          "再看真实的行业节点中心性表:选个国家读它各行业的枢纽度",
          "切换到第二个国家对比,留下学习证据",
        ]}
      />
      <EvidencePanel evidence={evidence} title="本步要留下的证据:在中心性表里切换国家,看过至少两个实体" />

      <ChartStory
        eyebrow="先建直觉 · 在一个小网络上"
        title="度 / 介数中心性是怎么数出来的"
        what={<>一个小的有向网络,切换<b>度 / 介数 / 接近</b>三种中心性,看每个节点的值是怎么一步步数出来的。</>}
        read={<><b>度</b> = 直接连了几条边;<b>介数</b> = 有多少条最短路径经过它(越高越是中转枢纽);<b>接近</b> = 到其他节点平均有多近。</>}
        find={<>把这些直觉记住,下一节就用在真实的全球国家×行业生产图上。</>}
      >
        <NetworkCentralityDemo />
      </ChartStory>

      <ChartStory
        eyebrow="计算结果 · 真实全球图"
        title="行业节点中心性表(从 ICIO 网络算出来的)"
        what={<>把投入产出表当成<b>有向图</b>(节点 = 国家×行业,边 = 中间品流量),按 Gephi 口径算出的中心性:选个国家,看它各行业节点的度、加权度、介数等。</>}
        read={<><b>介数</b>高 = 该行业是全球供应链的<b>中转枢纽</b>(很多最短供应路径经过它);<b>加权度</b>高 = 直接吞吐的中间品流量大。</>}
        find={<>换个国家看不同的枢纽行业:制造业大国的电子 / 金属 / 化工节点介数通常更高。</>}
        note="中心性在完整全球国家×行业图上计算。国家级贸易图是完全图、介数恒为 0、无区分度,所以枢纽识别只在国家–行业级做(见步骤 10)。"
      >
        <IndicatorTable
          meta={meta} groupKey="network" schema={schema} evidence={evidence}
          year={year} country={country} page={page}
          onYear={setYear} onCountry={setCountry} onPage={setPage}
        />
      </ChartStory>
    </div>
  );
}
