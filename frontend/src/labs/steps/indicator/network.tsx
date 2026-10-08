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
    // Recording must not replace the “全部” browsing choice with the recorded country.
    browseCountry: controls.country,
  });

  return (
    <div>
      <IndicatorMethodIntro topic="network">
        <details className="method-demo">
          <summary>可选：在一个小网络上看度与介数怎么数</summary>
          <p className="muted">切换度 / 介数 / 接近，点选节点看每个值是怎么一步步数出来的。这里每条连接都算一样长，只帮你建立直觉。</p>
          <NetworkCentralityDemo />
          <section className="network-demo-bridge" aria-labelledby="network-demo-bridge-title">
            <h3 id="network-demo-bridge-title">从小网络示意到当前数据网络</h3>
            <div><b>小网络的边</b><span>一条手工连接</span><i aria-hidden="true">→</i><b>数据网络的边</b><span>一个国家×行业向另一个节点提供的中间品（金额为正）</span></div>
            <div><b>小网络的度</b><span>直接连接条数</span><i aria-hidden="true">→</i><b>加权总度（买入 + 卖出）</b><span>流入和流出的中间品金额之和；自环（行业卖给自己的部分）在买入和卖出各算一次</span></div>
            <div><b>小网络的介数</b><span>处在多少条最短路线上</span><i aria-hidden="true">→</i><b>行业节点的介数</b><span>同样只看连接、不看金额，只作参考</span></div>
          </section>
        </details>
      </IndicatorMethodIntro>

      <section className="indicator-real-heading" aria-label="当前数据的中心性表">
        <span className="icio-kicker">02 / 动手查看 · OECD ICIO 网络</span>
        <h2>行业节点的中心性</h2>
        <p>选择一个国家，在该国全部行业中切换“按加权总度从高到低 / 按介数从高到低”：两种排序一致吗？国家选“全部”时只按默认顺序列出，不是全球排名。时间趋势与国家比较在步骤 9。</p>
        <IndicatorTable
          meta={meta} groupKey="network" schema={schema.data} state={state}
          year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
          onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage}
        />
        <AutoMaterialStatus meta={meta} state={state} schema={schema.data} {...auto} onSecond={controls.setPartner} where="上方表格所选国家"
          note="报告记录的是国家整体的加权总度 = 该国对外出口 + 进口（含最终品，不含国内流量），和上表的行业数值算法不同，不要直接比较。" />
      </section>
    </div>
  );
}
