import { useEffect } from "react";
import { api } from "../../../api";
import { explicitDemoCountry } from "../../../decomposition-model";
import { DecompositionDemo } from "../../../demos";
import { STEP_MATERIAL_ACTION_ID } from "../../../step-task-card";
import type { IndicatorSchema, Meta, Step, StepStateApi } from "../../../types";
import { countryLabel } from "../../../viz";
import { fieldLabel, fmtField, useAsync } from "../../shared";
import { IndicatorMethodIntro, type MethodTopic } from "./indicator-method-intro";
import {
  COUNTRY_METRIC,
  type IndicatorStepState,
  indicatorComparisonPatch,
  useIndicatorControls,
} from "./indicator-table";
import "./indicator-method.css";

export interface CalculationStepProps { meta: Meta; step: Step; state: StepStateApi<IndicatorStepState> }
const content = {
  trade: { demo: 4, title: "这笔出口的钱来自哪里？", hint: "选一个真实国家与行业，点看分项金额与含义。加总核对只检查账户一致性，不等于独立证明算法正确。" },
  production: { demo: 5, title: "本国增加值走了哪几条路？", hint: "把真实增加值分成纯国内、传统贸易、简单GVC和复杂GVC。这里追踪价值去向，与上一步从出口看价值来源不同。" },
  length: { demo: 6, title: "哪些生产活动拉长了价值链？", hint: "每段对总长度的贡献 = 增加值份额 × 该段长度。最长的一段，不一定贡献最大。" },
};

/** The country shown in “动手拆解” plus a fixed partner (USA, or CHN when the student picks USA). */
export function autoComparisonCountries(meta: Meta, selected: string): [string, string] {
  const first = selected || (meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "");
  const preferred = first === "USA" ? "CHN" : "USA";
  const partner = preferred !== first && meta.countries.includes(preferred)
    ? preferred
    : meta.countries.find((code) => code !== first && code !== "ROW") ?? "";
  return [first, partner];
}

function comparisonUnit(metric: string, schema: IndicatorSchema | null | undefined): string {
  const format = schema?.fields[metric]?.format;
  if (format === "pct") return "%";
  if (format === "amount") return "百万美元";
  return "无量纲";
}

export function CalculationStep({ topic, meta, state }: CalculationStepProps & { topic: MethodTopic }) {
  const controls = useIndicatorControls(meta, state);
  const schema = useAsync(() => api.indicatorSchema(), []);
  const cfg = content[topic];
  const year = controls.year;
  const [first, partner] = autoComparisonCountries(meta, explicitDemoCountry(meta.countries, controls.country) ?? "");
  const metric = COUNTRY_METRIC[topic];
  const release = meta.dataset?.release_id ?? "";
  const countryRequestKey = JSON.stringify(["auto-comparison", year]);
  const countryQuery = useAsync(
    async () => ({ year, rows: await api.countryIndicators(year) as Array<Record<string, unknown>> }),
    [countryRequestKey],
    { requestKey: countryRequestKey },
  );
  const rows = countryQuery.status === "success" && countryQuery.data?.year === year ? countryQuery.data.rows : null;
  const patch = rows && schema.status === "success"
    ? indicatorComparisonPatch(rows, [first, partner], year, metric, comparisonUnit(metric, schema.data), release, "auto-indicator-comparison")
    : null;
  const patchKey = patch ? JSON.stringify([patch.compared, patch.observations]) : "";
  const savedKey = JSON.stringify([state.data?.compared, state.data?.observations]);

  // Report material follows what the student is looking at: no extra button or table to open.
  useEffect(() => {
    if (!patch || patchKey === savedKey) return;
    state.save(patch);
    // state is a new object each render; the keys capture every meaningful change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey, savedKey]);

  const recorded = state.data?.observations?.filter((item) => item.source === "auto-indicator-comparison" || item.source === "explicit-indicator-table-comparison") ?? [];
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
      <p id={STEP_MATERIAL_ACTION_ID} tabIndex={-1} className="auto-material" role="status">
        <b>报告材料 · 自动记录</b>
        {recorded.length === 2
          ? <span>{recorded[0].year} 年 · {recorded.map((item) => `${countryLabel(item.country)} ${fmtField(item.value, item.metric, schema.data)}`).join("；")} · {fieldLabel(recorded[0].metric, schema.data)}</span>
          : <span>{countryQuery.status === "error" ? "国家级数据加载失败，请刷新后重试。" : "正在根据上方国家自动记录…"}</span>}
        <small>按上方所选国家与美国（选美国时改为中国）在同一年的本步代表指标自动记录，无需另外保存。</small>
      </p>
    </section>
  </div>;
}
