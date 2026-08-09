/**
 * 步骤 6 · 指标计算(网络)—— 故事:「把经济当成一张网:谁是枢纽?」
 *
 * 网络没有加总恒等式,所以顺序与 3/4/5 相反:先用小网络建立“度 / 介数是怎么数出来
 * 的”直觉,再看真实的全球国家×行业中心性表(否则一堆抽象数字看不懂)。
 * 保留 NetworkCentralityDemo(合成小图)。中心性只在国家–行业级有意义(国家图是
 * 完全图、介数恒为 0,见 country_degenerate 与步骤 10)。
 */
import { api } from "../../../api";
import { NetworkCentralityDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory, StepIntro } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function Step7Network({ meta, step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <StepIntro
        kicker={`步骤 ${step.n} · 指标计算`}
        lead="把生产联系画成一张网：哪些节点处于枢纽位置？"
        concept={step.concept}
        todo={[
          "先在小网络上看懂度 / 介数中心性是怎么数出来的",
          "再看真实的行业节点中心性表：选择一个经济体，读取各行业的枢纽指标",
          "切换经济体进行对比；当前选择会自动保存到实验记录",
        ]}
      />

      <ChartStory
        eyebrow="先建直觉 · 在一个小网络上"
        title="度与介数中心性是怎样计算的"
        what={<>在一个小型有向网络中切换<b>度、介数和接近中心性</b>，查看每个节点的数值如何得到。</>}
        read={<><b>度</b>表示直接连接数量；<b>介数</b>表示有多少条最短路径经过该节点，数值越高越可能处于中转位置；<b>接近中心性</b>表示到其他节点的平均距离。</>}
        find={<>找一个连接很多但介数不高的节点，再找一个连接较少但位于关键路径上的节点，比较两类指标的差别。</>}
      >
        <NetworkCentralityDemo />
      </ChartStory>

      <ChartStory
        eyebrow="计算结果 · 真实全球图"
        title="行业节点中心性表（由 ICIO 网络计算）"
        what={<>把投入产出表看作<b>有向图</b>：节点是经济体×行业，边是中间品流量。选择一个经济体，查看各行业节点的度、加权度和介数等指标。</>}
        read={<><b>介数</b>较高表示更多有向最短路径经过该行业节点；<b>加权度</b>较高表示直接流入和流出的中间品规模较大。两者刻画的枢纽含义不同。</>}
        find={<>切换两个经济体，检查电子、金属或化工等行业的介数是否都较高，并用表中数值说明观察结果。</>}
        note="中心性在完整全球经济体×行业图上计算。经济体层贸易图接近完全图，无权介数恒为 0，因此枢纽识别只在经济体×行业层进行（见步骤 10）。"
      >
        <IndicatorTable
          meta={meta} groupKey="network" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>
    </div>
  );
}
