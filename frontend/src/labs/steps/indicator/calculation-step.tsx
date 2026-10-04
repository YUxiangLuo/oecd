import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import { explicitDemoCountry } from "../../../decomposition-model";
import type { Meta, Step, StepStateApi } from "../../../types";
import { countryLabel } from "../../../viz";
import { useAsync } from "../../shared";
import { AutoMaterialStatus, useAutoComparison } from "./auto-comparison";
import { IndicatorMethodIntro } from "./indicator-method-intro";
import { type IndicatorStepState, useIndicatorControls } from "./indicator-table";
import "./indicator-method.css";

export interface CalculationStepProps { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }
const content = {
  trade: { demo: 4, title: "这笔出口的钱来自哪里？", hint: "选一个真实国家与行业，点看分项金额与含义。加总核对只检查账户一致性，不等于独立证明算法正确。" },
  production: { demo: 5, title: "本国增加值走了哪几条路？", hint: "把真实增加值分成纯国内、传统贸易、简单GVC和复杂GVC。这里追踪价值去向，与上一步从出口看价值来源不同。" },
  length: { demo: 6, title: "哪些生产活动拉长了价值链？", hint: "每段对总长度的贡献 = 增加值份额 × 该段长度。最长的一段，不一定贡献最大。" },
};

export function CalculationStep({ topic, meta, state }: CalculationStepProps & { topic: "trade" | "production" | "length" }) {
  const controls = useIndicatorControls(meta, state);
  const schema = useAsync(() => api.indicatorSchema(), []);
  const cfg = content[topic];
  const year = controls.year;
  const { first, loadFailed } = useAutoComparison({
    topic, meta, state, year, schema,
    country: explicitDemoCountry(meta.countries, controls.country) ?? "",
  });
  return <div>
    <IndicatorMethodIntro topic={topic} />
    <section className="indicator-real-heading" aria-label="真实数据动手拆解">
      <span className="icio-kicker">02 / 动手拆解 · 真实ICIO数据</span>
      <h2>{cfg.title}</h2><p>{cfg.hint} 时间趋势与国家比较在步骤 {topic === "trade" ? 6 : topic === "production" ? 7 : 8}。</p>
      <div className="indicator-real-controls">
        <label>选择真实国家<select value={first} onChange={(event) => controls.setCountry(event.target.value)}>
          {meta.countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}
        </select></label>
      </div>
      <DecompositionDemo step={cfg.demo} meta={meta} primaryYear={year}
        primaryCountry={first} onPrimaryChange={controls.setPrimary} />
      <AutoMaterialStatus state={state} schema={schema.data} loadFailed={loadFailed} where="上方所选国家" />
    </section>
  </div>;
}
