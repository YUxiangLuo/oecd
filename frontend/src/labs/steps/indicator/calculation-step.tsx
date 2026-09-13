import { api } from "../../../api";
import { explicitDemoCountry } from "../../../decomposition-model";
import { DecompositionDemo } from "../../../demos";
import type { Meta, Step, StepStateApi } from "../../../types";
import { countryLabel } from "../../../viz";
import { useAsync } from "../../shared";
import { IcioExperiment, type IndicatorTopic } from "./icio-experiment";
import { IndicatorTable, type IndicatorStepState, useIndicatorControls } from "./indicator-table";

export interface CalculationStepProps { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }
const content = {
  trade: { demo: 4, title: "这笔出口的钱来自哪里？", hint: "选一个真实国家与行业，点看分项金额与含义。加总核对只检查账户一致性，不等于独立证明算法正确。", note: "出口分为五类WWZ聚合项和产品税减补贴扩展；TLS为负可表示净补贴，重复计算项不是为闭合而相减的负项。" },
  production: { demo: 5, title: "本国增加值走了哪几条路？", hint: "把真实增加值分成纯国内、传统贸易、简单GVC和复杂GVC。这里追踪价值去向，与上一步从出口看价值来源不同。", note: "四类加总为总增加值SVA。复杂GVC份额描述生产活动构成，不自动代表技术水平或收益高低。" },
  length: { demo: 6, title: "哪些生产活动拉长了价值链？", hint: "每段对总长度的贡献 = 增加值份额 × 该段长度。最长的一段，不一定贡献最大。", note: "前向从价值来源出发，后向从最终产品回溯。位置指数比较两者的GVC段，大于1只表示该口径下相对上游；存在负增加值时是有符号加权，不保证总长度介于各段极值之间。" },
};

export function CalculationStep({ topic, meta, state }: CalculationStepProps & { topic: IndicatorTopic }) {
  const controls = useIndicatorControls(meta, state);
  const schema = useAsync(() => api.indicatorSchema(), []);
  const cfg = content[topic];
  return <div>
    <IcioExperiment topic={topic} />
    <section className="indicator-real-heading" aria-label="真实数据动手拆解">
      <span className="icio-kicker">02 / 动手拆解 · 真实ICIO数据</span>
      <h2>{cfg.title}</h2><p>{cfg.hint}</p>
      <div className="indicator-real-controls">
        <label>选择真实国家<select value={controls.country} onChange={(event) => controls.setCountry(event.target.value)}>
          <option value="">请选择国家</option>{meta.countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}
        </select></label>
        <span className="muted">时间趋势与国家比较请前往步骤{topic === "trade" ? 6 : topic === "production" ? 7 : 8}。</span>
      </div>
      <DecompositionDemo step={cfg.demo} meta={meta} primaryYear={controls.year}
        primaryCountry={explicitDemoCountry(meta.countries, controls.country)} onPrimaryChange={controls.setPrimary} />
      <details><summary>如何准确理解这次拆解？</summary><p>{cfg.note}</p></details>
    </section>
    <details className="indicator-full-data"><summary>03 / 查看完整真实数据与记录实验结果</summary>
      <p className="muted">教学小实验不会写入报告。这里保留真实数据明细、列定义与实验结果记录。</p>
      <IndicatorTable meta={meta} groupKey={topic} schema={schema.data} state={state}
        year={controls.year} country={controls.country} page={controls.page} interacted={controls.interacted}
        onYear={controls.setYear} onCountry={controls.setCountry} onPage={controls.setPage} />
    </details>
  </div>;
}
