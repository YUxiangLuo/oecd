/**
 * 步骤 5 · 全球生产网络指标：01 计算方法（含文档；小网络演示为可选折叠）→ 02 当前数据的中心性表。
 * 报告材料按中心性表所选国家自动记录（国家级加权总度；国家完全图的介数恒为 0）。
 */
import { api } from "../../../api";
import { NetworkCentralityDemo } from "../../../demos";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { AutoMaterialStatus, useAutoComparison } from "./auto-comparison";
import { IndicatorMethodIntro } from "./indicator-method-intro";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";
import "./indicator-method.css";

export function NetworkIndicatorStep({ meta, step: _step, state }: { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }) {
  const controls = useIndicatorControls(meta, state);
  const schema = useAsync<IndicatorSchema>(() => api.indicatorSchema(), []);
  const auto = useAutoComparison({
    topic: "network", meta, state, year: controls.year, schema,
    // “全部” pages the global table without picking a country; keep the recorded pair instead of
    // replacing it with the CHN–USA default the student never chose.
    country: meta.countries.includes(controls.country)
      ? controls.country
      : state.data?.compared?.find((code) => meta.countries.includes(code)) ?? "",
    partner: controls.partner,
  });

  return (
    <div>
      <IndicatorMethodIntro topic="network">
        <details className="method-demo">
          <summary>可选：在一个小网络上看度与介数怎么数</summary>
          <p className="muted">切换度 / 介数 / 接近，点选节点看每个值是怎么一步步数出来的。这里每条正边的路径长度都相同，只是二值拓扑直觉。</p>
          <NetworkCentralityDemo />
          <section className="network-demo-bridge" aria-labelledby="network-demo-bridge-title">
            <h3 id="network-demo-bridge-title">从小网络示意到当前数据网络</h3>
            <div><b>小网络的边</b><span>一条手工连接</span><i aria-hidden="true">→</i><b>数据网络的边</b><span>一个国家×行业向另一节点提供的正中间品流</span></div>
            <div><b>小网络的度</b><span>直接连接条数</span><i aria-hidden="true">→</i><b>加权总度</b><span>入向+出向流量；正自环双计</span></div>
            <div><b>小网络的介数</b><span>最短路径中介位置</span><i aria-hidden="true">→</i><b>行业节点的介数</b><span>仍按无权路径计算，只作探索性拓扑指标</span></div>
          </section>
        </details>
      </IndicatorMethodIntro>

      <section className="indicator-real-heading" aria-label="当前数据的中心性表">
        <span className="icio-kicker">02 / 动手查看 · 当前数据网络</span>
        <h2>行业节点的中心性</h2>
        <p>选择一个国家，在该国全部行业中切换“加权度降序 / 介数降序”：两种排序一致吗？全球分页视图不做排序，不是全球排名。时间趋势与国家比较在步骤 9。</p>
        <IndicatorTable
          meta={meta} groupKey="network" schema={schema.data} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
        <AutoMaterialStatus meta={meta} state={state} schema={schema.data} {...auto} onSecond={controls.setPartner} where="上方表格所选国家"
          note="国家级加权总度只含国家之间的贸易（不含国内流量），不能与上表含国内流量的行业数值直接比较。" />
      </section>
    </div>
  );
}
