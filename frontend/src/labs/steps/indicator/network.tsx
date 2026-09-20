/**
 * 步骤 5 · 指标计算(网络)—— 故事:「流量规模与二值拓扑位置有何不同?」
 *
 * 网络没有加总恒等式,所以顺序与 3/4/5 相反:先用小网络建立“度 / 介数是怎么数出来
 * 的”直觉,再看真实的全球国家×行业中心性表(否则一堆抽象数字看不懂)。
 * 保留 NetworkCentralityDemo(合成小图)。中心性只在国家–行业级有意义(国家图是
 * 完全图、介数恒为 0,见 country_degenerate 与步骤 9)。
 */
import { api } from "../../../api";
import { NetworkCentralityDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { ChartStory } from "../viz/scaffold";
import { IndicatorReadingLibrary } from "./indicator-reading-library";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function NetworkIndicatorStep({ meta, step: _step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <ChartStory
        eyebrow="先建直觉 · 在一个小网络上"
        title="流量规模 / 二值介数是怎么数出来的"
        what={<>一个小的有向网络,切换<b>度 / 介数 / 接近</b>三种中心性,看每个节点的值是怎么一步步数出来的。</>}
        read={<><b>度</b> = 直接连了几条边；<b>介数</b> = 各节点对最短路径经过它的份额之和（等长路径分摊）；<b>接近</b> = 按无权路径到其他节点平均有多近。这里每条正边的路径长度都相同，所以只是二值拓扑直觉。</>}
        find={<>哪个节点连接多，哪个节点经常位于路径中间？下一节用当前数据网络比较这两种情况。</>}
      >
        <NetworkCentralityDemo />
      </ChartStory>

      <section className="network-demo-bridge" aria-labelledby="network-demo-bridge-title">
        <h3 id="network-demo-bridge-title">从小网络示意到当前数据网络</h3>
        <div><b>小网络的边</b><span>一条手工连接</span><i aria-hidden="true">→</i><b>数据网络的边</b><span>一个国家×行业向另一节点提供的正中间品流</span></div>
        <div><b>小网络的度</b><span>直接连接条数</span><i aria-hidden="true">→</i><b>加权总度</b><span>入向+出向流量；正自环双计</span></div>
        <div><b>小网络的介数</b><span>最短路径中介位置</span><i aria-hidden="true">→</i><b>行业节点的介数</b><span>仍按无权路径计算，只作探索性拓扑指标</span></div>
      </section>

      <ChartStory
        eyebrow="计算结果 · 当前数据网络"
        title="行业节点中心性表(从 ICIO 网络算出来的)"
        what={<>把投入产出表当成<b>有向图</b>(节点 = 国家×行业,边 = 中间品流量),按 Gephi 口径算出的中心性:选个国家,看它各行业节点的度、加权度、介数等。</>}
        read={<><b>加权度</b>比较流入和流出规模；<b>介数</b>比较节点在最短路径中的中介位置，不自动等于经济瓶颈。各列完整定义见列说明。</>}
        find={<>选择一个国家，在该国全部行业中切换<b>加权度降序 / 介数降序</b>，两种排序是否一致？全球分页视图不做排序，不是全球排名。</>}
        note="中心性在当前数据的完整国家×行业图上计算。路径指标把所有正流量边视为等长，未做边阈值敏感性分析；国家级完全图的介数恒为 0，不用于区分国家的经济作用。"
      >
        <IndicatorTable
          meta={meta} groupKey="network" schema={schema} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
      </ChartStory>
      <IndicatorReadingLibrary topic="network" />
    </div>
  );
}
