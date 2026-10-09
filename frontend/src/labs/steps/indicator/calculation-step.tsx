import { api } from "../../../api";
import { DecompositionDemo } from "../../../demos";
import { explicitDemoCountry } from "../../../decomposition-model";
import type { Meta, Step, StepStateApi } from "../../../types";
import { useAsync } from "../../shared";
import { AutoMaterialStatus, useAutoMaterial } from "./auto-comparison";
import { IndicatorMethodIntro } from "./indicator-method-intro";
import { type IndicatorStepState, useIndicatorControls } from "./indicator-table";
import "./indicator-method.css";

export interface CalculationStepProps { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }
const content = {
  trade: { demo: 4, title: "一国出口的价值来自哪里？", hint: "选一个国家，对照各分项的金额、占比与含义；切换到“单个行业”可看具体行业。" },
  production: { demo: 5, title: "本国增加值经由哪些路径被最终使用？", hint: "把一国的增加值分成纯国内、传统贸易、简单 GVC 和复杂 GVC。这里追踪增加值的去向，与上一步从出口看价值来源不同。" },
  length: { demo: 6, title: "哪些生产活动拉长了价值链？", hint: "每段对总长度的贡献 = 增加值份额 × 该段长度。最长的一段，不一定贡献最大。" },
};

export function CalculationStep({ topic, meta, state }: CalculationStepProps & { topic: "trade" | "production" | "length" }) {
  const controls = useIndicatorControls(meta, state);
  const schema = useAsync(() => api.indicatorSchema(), []);
  const cfg = content[topic];
  const year = controls.year;
  const auto = useAutoMaterial({
    topic, meta, state, year, schema,
    country: explicitDemoCountry(meta.countries, controls.country) ?? "",
  });
  return <div>
    <IndicatorMethodIntro topic={topic} />
    <section className="indicator-real-heading" aria-label="真实数据动手拆解">
      <span className="icio-kicker">02 / 动手拆解 · OECD ICIO 数据</span>
      <h2>{cfg.title}</h2><p>{cfg.hint} 时间趋势与国家比较在步骤 {topic === "trade" ? 6 : topic === "production" ? 7 : 8}。</p>
      {/* The country select is the first control of the panel below. */}
      {controls.carriedNote && <p className="muted indicator-carried-note" role="note">{controls.carriedNote}</p>}
      <DecompositionDemo step={cfg.demo} meta={meta} primaryYear={year}
        primaryCountry={auto.country} onPrimaryChange={controls.setPrimary}
        initialView={state.data?.browse_selection} onViewChange={(view) => state.saveView?.({ browse_selection: view })} />
      <AutoMaterialStatus state={state} schema={schema.data} {...auto} where="上方所选国家" />
    </section>
  </div>;
}
