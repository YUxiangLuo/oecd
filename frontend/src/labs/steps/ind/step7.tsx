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
import { ChartStory } from "../viz/scaffold";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export function Step7Network({ meta, step: _step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const { data: schema } = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);

  return (
    <div>
      <ChartStory
        eyebrow="先建直觉 · 在一个小网络上"
        title="度 / 介数中心性是怎么数出来的"
        what={<>一个小的有向网络,切换<b>度 / 介数 / 接近</b>三种中心性,看每个节点的值是怎么一步步数出来的。</>}
        read={<><b>度</b> = 直接连了几条边;<b>介数</b> = 各节点对最短路径经过它的份额之和（等长路径分摊）;<b>接近</b> = 按无权路径到其他节点平均有多近。这里每条正边的路径长度都相同。</>}
        find={<>把这些直觉记住,下一节就用在真实的全球国家×行业生产图上。</>}
      >
        <NetworkCentralityDemo />
      </ChartStory>

      <section className="network-demo-bridge" aria-labelledby="network-demo-bridge-title">
        <h3 id="network-demo-bridge-title">把小网络的直觉带到真实全球图</h3>
        <div><b>小网络的边</b><span>一条手工连接</span><i aria-hidden="true">→</i><b>真实图的边</b><span>一个国家×行业向另一节点提供的正中间品流</span></div>
        <div><b>小网络的度</b><span>直接连接条数</span><i aria-hidden="true">→</i><b>真实图先看加权度</b><span>直接连接流量规模，作为经济量基准</span></div>
        <div><b>小网络的介数</b><span>无权最短路径中介位置</span><i aria-hidden="true">→</i><b>真实图的介数</b><span>仍是拓扑基准；完全国家图会退化为常数，因此只在国家×行业图解释</span></div>
      </section>

      <ChartStory
        eyebrow="计算结果 · 真实全球图"
        title="行业节点中心性表(从 ICIO 网络算出来的)"
        what={<>把投入产出表当成<b>有向图</b>(节点 = 国家×行业,边 = 中间品流量),按 Gephi 口径算出的中心性:选个国家,看它各行业节点的度、加权度、介数等。</>}
        read={<>默认列同时显示<b>加权度、介数、度 / 入度 / 出度与接近中心性</b>。介数高表示更多节点对的有向无权最短路径份额经过该节点，不自动等于经济瓶颈；加权度才直接汇总中间品流量。</>}
        find={<>选择一个国家后，用原生排序选择器在该国全部 45 个行业内切换<b>加权度降序 / 介数降序</b>并比较。全球分页视图不做排序，也不声称是全球排名。</>}
        note="中心性在完整全球国家×行业图上计算。加权度是流量规模基准；路径类指标不使用流量权重，当前也没有做边阈值敏感性分析。国家级贸易图是完全图、介数恒为 0、无区分度。"
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
