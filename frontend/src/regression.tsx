import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { api } from "./api";
import { useAsync } from "./labs";
import { comparisonExplanation, lessonQuestion, REGRESSION_LESSONS, REGRESSION_QUESTION } from "./regression-lessons";
import {
  eventInferenceAllowed, eventInferenceGate, eventInferenceMessage, eventMainPretrendContractIsSafe,
  eventPretrendScopesAreSafe, eventSupportCoversTerms, GLOBAL_PRETREND_SUPPRESSION_COPY,
  globalInferenceIsSuppressed, pretrendPeriodCount,
} from "./regression-event-support";
import { isQualifiedRegressionResult, nextRegressionSave } from "./regression-save";
import {
  DidFourCells,
  FamilyMap,
  ReadingCoach,
  RegressionReadingCheck,
  SiblingContrast,
  readingAnswerForDirection,
  type RegressionReadingAnswer,
  type RegressionReadingCheckState,
  type SiblingStepData,
} from "./regression-teach";
import {
  buildRegressionVerdict,
  chartDisplayScale,
  placeboInterpretation,
  regressionStatusLabel,
} from "./regression-verdict";
import { splitPolicyCoefficients } from "./regteach";
import type {
  MarginalEffect,
  PlaceboResponse,
  QuizCompletionState,
  RegressionDesignInfo,
  RegressionOptions,
  RegressionOutcome,
  RegressionResponse,
  Step,
  StepStateApi,
} from "./types";
import { userFacingRequestError } from "./user-facing-error";
import { CoefForestChart, EventStudyChart, PlaceboChart } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
// 与后端 METHOD_LABELS、题库和报告保持同一套方法名，避免学生以为那是三种不同估计量。
const METHOD_LABELS: Record<string, string> = {
  did: "分批处理 cohort-time ATT",
  twfe_intensity: "连续强度 TWFE（描述性）",
  event_study: "cohort-aware 动态 ATT",
};
const SCENARIO_LABELS: Record<string, string> = {
  clean: "基准教学面板",
  noisy: "课堂挑战：人为加入测量噪声",
  confounded: "课堂挑战：人为加入冲击前趋势",
};

/**
 * Keep the fixed application shell anchored to the viewport while revealing a
 * freshly calculated verdict inside the course's own scroll container.
 * `Element.scrollIntoView()` also scrolls the document in this nested layout,
 * which can move the entire 100vh application off screen.
 */
export function scrollRegressionVerdict(target: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!target) return;
  const scroller = target.closest<HTMLElement>(".content");
  if (!scroller) {
    target.scrollIntoView({ behavior, block: "start" });
    return;
  }
  const top = scroller.scrollTop
    + target.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top, left: 0, behavior });
}

export interface RegressionSettings {
  granularity: string;
  shockType: string;
  method: string;
  controlMode: string;
  interaction: boolean;
  priceMode: string;
  scenario: string;
  weightMode: string;
}

export const DEFAULT_REGRESSION_SETTINGS: RegressionSettings = {
  granularity: "country_industry",
  shockType: "tariff",
  method: "did",
  controlMode: "none",
  interaction: false,
  priceMode: "nominal",
  scenario: "clean",
  weightMode: "fixed_pretreatment",
};

/** 四步同一主口径：关税 × cohort-time ATT；方法课进「换一种读法」。
 *  改动仍按 outcome 分别保留(见 App.tsx 里 regression_settings)。 */
export const SIGNATURE_SETTINGS: Record<RegressionOutcome, RegressionSettings> = {
  trade: { ...DEFAULT_REGRESSION_SETTINGS },
  production: { ...DEFAULT_REGRESSION_SETTINGS },
  length: { ...DEFAULT_REGRESSION_SETTINGS },
  network: { ...DEFAULT_REGRESSION_SETTINGS, granularity: "country_industry" },
};

export function normalizeRegressionSettings(settings: RegressionSettings): RegressionSettings {
  const cohortAware = settings.method === "did" || settings.method === "event_study";
  const mustResetPublicControls = settings.controlMode !== "none" || settings.priceMode !== "nominal";
  const mustResetInteraction = cohortAware && settings.interaction;
  let normalized = mustResetPublicControls || mustResetInteraction
    ? {
      ...settings,
      controlMode: "none",
      priceMode: "nominal",
      interaction: cohortAware ? false : settings.interaction,
    }
    : settings;
  if (normalized.shockType !== "tariff" && normalized.weightMode !== "fixed_pretreatment") {
    normalized = { ...normalized, weightMode: "fixed_pretreatment" };
  }
  return normalized;
}

/** 会话里 regression_settings 现按 outcome 存(map);历史上的单份扁平设定(含 method
 *  顶层键)一律忽略,让各步重新按招牌默认 seed——与“不做历史格式兼容”一致。 */
export function asRegressionSettingsMap(value: unknown): Partial<Record<RegressionOutcome, RegressionSettings>> {
  if (!value || typeof value !== "object" || "method" in value) return {};
  return value as Partial<Record<RegressionOutcome, RegressionSettings>>;
}

type SharedSettingsProps = {
  settings: RegressionSettings;
  onSettingsChange: (settings: RegressionSettings) => void;
};

function Pills({ options, value, onChange, label, labelMap, disabled = false }: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  labelMap?: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <div className="pill-row" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={`pill${value === option ? " on" : ""}`}
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {labelMap?.[option] ?? option}
        </button>
      ))}
    </div>
  );
}

function DesignMeta({ design }: { design: RegressionDesignInfo }) {
  const controls = design.controls.length
    ? design.controls.map((control) => design.control_labels[control] ?? control).join("、")
    : "不加控制变量";
  return (
    <div className="design-meta">
      <span>结果指标：{design.depvar_label}</span>
      <span>政策冲击：{design.shock_type}</span>
      <span>面板：{design.panel_file}</span>
      <span>观察个体：{ENTITY_LABEL[design.entity] ?? design.entity}</span>
      <span>标准误按{ENTITY_LABEL[design.cluster] ?? design.cluster}聚类</span>
      <span>控制：{controls}</span>
      <span>交互：{design.interaction ? "冲击 × 中心化处理前 GVC" : "未加入"}</span>
      <span>样本：{design.sample_filter}</span>
      <span>暴露权重：{design.weight_mode === "contemporaneous" ? "当期贸易结构（稳健性）" : "首次处理前固定结构（基准）"}</span>
    </div>
  );
}

function DesignEquation({ design }: { design: RegressionDesignInfo }) {
  const [description, setDescription] = useState<string | null>(null);
  const parts = design.equation_parts?.length ? design.equation_parts : [{ text: design.equation }];
  return (
    <div>
      <div className="model-eq" role="group" aria-label="当前实际运行方程">
        {parts.map((part, index) => {
          const interactive = Boolean(part.description);
          return (
            <span
              key={`${part.text}-${index}`}
              tabIndex={interactive ? 0 : undefined}
              title={part.description}
              onMouseEnter={() => setDescription(part.description ?? null)}
              onMouseLeave={() => setDescription(null)}
              onFocus={() => setDescription(part.description ?? null)}
              onBlur={() => setDescription(null)}
              style={interactive ? { cursor: "help", borderBottom: "1px dotted #8b88df" } : undefined}
            >
              {part.text}
            </span>
          );
        })}
      </div>
      {description && <p className="muted" role="status">{description}</p>}
      <DesignMeta design={design} />
    </div>
  );
}

interface RunSnapshot {
  id: number;
  settings: RegressionSettings;
  response: RegressionResponse;
}

export type RegressionHistory = Partial<Record<RegressionOutcome, RunSnapshot[]>>;

export interface DidCohortWeight {
  cohort: number;
  cellCount: number;
  treatedEntityPeriods: number;
  share: number;
}

/** 总体 DID 的真实聚合权重。每个 cohort×post 单元按可用处理实体数计权，
 * 因而早期 cohort 会通过更多 post 单元重复贡献。只从服务端已发布单元推导，
 * 不根据时间线总数猜测。 */
export function didCohortWeights(response: RegressionResponse): DidCohortWeight[] {
  if (response.design.method !== "did") return [];
  const cells = response.result.diagnostics.cohort_time_cells ?? [];
  const term = response.result.coefs[0]?.name;
  const grouped = new Map<number, { cellCount: number; treatedEntityPeriods: number }>();
  for (const cell of cells) {
    if (cell.term !== term || !Number.isInteger(cell.cohort)
      || !Number.isFinite(cell.treated_entities) || cell.treated_entities <= 0) continue;
    const current = grouped.get(cell.cohort) ?? { cellCount: 0, treatedEntityPeriods: 0 };
    current.cellCount += 1;
    current.treatedEntityPeriods += cell.treated_entities;
    grouped.set(cell.cohort, current);
  }
  const denominator = [...grouped.values()].reduce((sum, item) => sum + item.treatedEntityPeriods, 0);
  if (denominator <= 0) return [];
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([cohort, value]) => ({ cohort, ...value, share: value.treatedEntityPeriods / denominator }));
}

const effectiveSettings = (settings: RegressionSettings): RegressionSettings => ({
  ...settings,
  priceMode: settings.controlMode === "none" ? "nominal" : settings.priceMode,
});
export const regressionSettingsKey = (settings: RegressionSettings) => {
  const effective = effectiveSettings(settings);
  // PostgreSQL jsonb does not preserve the insertion order of object keys. Build the
  // identity in one fixed order so a persisted run is not marked stale after reload.
  return JSON.stringify({
    granularity: effective.granularity,
    shockType: effective.shockType,
    method: effective.method,
    controlMode: effective.controlMode,
    interaction: effective.interaction,
    priceMode: effective.priceMode,
    scenario: effective.scenario,
    weightMode: effective.weightMode,
  });
};

export const regressionOptionsRequestKey = (outcome: RegressionOutcome) =>
  `regression-options:${outcome}`;

export const regressionDesignRequestKey = (
  outcome: RegressionOutcome,
  settings: RegressionSettings,
) => `regression-design:${outcome}:${regressionSettingsKey(settings)}`;

/** 把稳定键翻成展示文案。文案随 /api/regression/options 下发,
 *  拿不到时退回显示键本身——宁可露出 `tariff`,也不猜一个可能过时的中文。 */
type Labels = RegressionOptions | null | undefined;
const labelOf = (map: Record<string, string> | undefined, key: string) => map?.[key] ?? key;

function settingsSummary(settings: RegressionSettings, options: Labels): string {
  return [
    labelOf(options?.granularity_labels, settings.granularity),
    labelOf(options?.shock_type_labels, settings.shockType),
    METHOD_LABELS[settings.method] ?? settings.method,
    labelOf(options?.control_mode_labels, settings.controlMode),
    settings.interaction ? "含交互" : "无交互",
    settings.controlMode === "none" ? null : labelOf(options?.price_mode_labels, settings.priceMode),
    SCENARIO_LABELS[settings.scenario] ?? settings.scenario,
    settings.weightMode === "contemporaneous" ? "当期权重" : "固定处理前权重",
  ].filter(Boolean).join(" · ");
}

function changedSettingsSummary(settings: RegressionSettings, snapshots: RunSnapshot[], options: Labels): string {
  const fields: { key: keyof RegressionSettings; label: string }[] = [
    { key: "granularity", label: "粒度" },
    { key: "shockType", label: "冲击" },
    { key: "method", label: "方法" },
    { key: "controlMode", label: "控制" },
    { key: "interaction", label: "交互" },
    { key: "priceMode", label: "口径" },
    { key: "scenario", label: "场景" },
    { key: "weightMode", label: "暴露权重" },
  ];
  const maps: Partial<Record<keyof RegressionSettings, Record<string, string> | undefined>> = {
    granularity: options?.granularity_labels,
    shockType: options?.shock_type_labels,
    method: METHOD_LABELS,
    controlMode: options?.control_mode_labels,
    priceMode: options?.price_mode_labels,
    scenario: SCENARIO_LABELS,
    weightMode: options?.weight_mode_labels,
  };
  const changed = fields.filter(({ key }) => new Set(snapshots.map((snapshot) => snapshot.settings[key])).size > 1);
  return changed.length
    ? changed.map(({ key, label }) => `${label}=${labelOf(maps[key], String(settings[key]))}`).join(" · ")
    : "设定相同";
}

function RunComparison({ outcome, snapshots, onClear, options }: {
  outcome: RegressionOutcome;
  snapshots: RunSnapshot[];
  onClear: () => void;
  options: Labels;
}) {
  if (snapshots.length < 2) return null;
  return (
    <section className="reg-section-card">
      <div className="reg-section-heading">
        <div><span className="reg-section-step">比较</span><h3>改变设定后，结论变化了吗？</h3></div>
        <button className="secondary" onClick={onClear}>清空比较</button>
      </div>
      {new Set(snapshots.map((snapshot) => snapshot.response.design.method)).size > 1 && (
        <p className="comparison-warning">不同方法估计的对象不同，只能并列检查证据是否稳健，不能把系数直接相减。</p>
      )}
      <ScrollableRegion className="table-wrap" label="回归运行比较表，可横向滚动">
        <table className="data-table">
          <thead><tr><th>运行</th><th>改变的设定</th><th>估计对象</th><th>证据判断</th><th>效应</th></tr></thead>
          <tbody>
            {snapshots.map((snapshot) => {
              const verdict = buildRegressionVerdict(outcome, snapshot.response);
              return (
                <tr key={snapshot.id}>
                  <td title={settingsSummary(snapshot.settings, options)}>运行 {snapshot.id}</td>
                  <td>{changedSettingsSummary(snapshot.settings, snapshots, options)}</td>
                  <td>{verdict.effectLabel}</td>
                  <td>{verdict.title}</td>
                  <td>{verdict.effect}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollableRegion>
    </section>
  );
}

function VerdictCard({ outcome, response, stale }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  stale: boolean;
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const support = response.result.support;
  return (
    <section className={`verdict-card verdict-${verdict.state}`} aria-live="polite">
      <div className="verdict-kicker">本次估计首先告诉你</div>
      <h3>{verdict.title}</h3>
      {stale && <div className="stale-result">你已经修改了设定；以下是旧设定结果，请重新运行后再比较。</div>}
      {support?.suppress_inference && <p role="note">本次停止推断，不能判断效应方向。完整诊断也可作为报告材料；请解释原因，完成理解题后继续下一步。</p>}
      <div className="verdict-metrics">
        <div><span>{verdict.effectLabel}</span><b>{verdict.effect}</b></div>
        <div><span>95% 置信区间</span><b>{verdict.interval}</b></div>
      </div>
      <p>{verdict.evidence}</p>
      <p className="muted">95% 区间是逐项区间，不是四项结果或整条动态路径的同时置信带。</p>
      <p>{verdict.interpretation}</p>
      {support && (
        // 处理支持度必须和结论一起出现:总聚类很多、处理聚类极少,
        // 正是“样本很大所以可信”这一误读的来源。
        <p className="verdict-support">
          处理支持度：<b>{support.treated_clusters}</b> 个处理聚类 ·{" "}
          <b>{support.untreated_clusters}</b> 个估计样本内完全未暴露聚类 · 共 {response.result.n_clusters} 个聚类
          {support.paired_control_clusters != null && <> · {support.paired_control_clusters} 个实际配对贡献对照聚类</>}
          （{support.treated_entities} 个含处理后暴露行的实体 · {support.untreated_entities ?? "未记录"} 个估计样本内未暴露实体，后者可能包括冻结 cohort 中仅保留冲击前行的实体）
        </p>
      )}
      {support && support.untreated_clusters <= 3 && (
        <div className="reg-sparse-control-warning" role="alert">
          <b>对照基础很薄：</b>只有 {support.untreated_clusters} 个聚类在估计样本内始终未暴露。即使处理聚类数达到课程停止线，也不能据此认定反事实可信；必须在报告中限制因果表述。
        </div>
      )}
      {verdict.warnings.length > 0 && (
        <ul className="verdict-warnings">
          {verdict.warnings.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      <p className="verdict-boundary">{verdict.boundary}</p>
    </section>
  );
}

function RegressionEvidenceCard({ outcome, response, stale }: {
  outcome: RegressionOutcome;
  response: RegressionResponse;
  stale: boolean;
}) {
  const verdict = buildRegressionVerdict(outcome, response);
  const support = response.result.support;
  const cohortWeights = didCohortWeights(response);
  const dominantCohort = cohortWeights.find((row) => row.share >= 0.75);
  return (
    <section className="reg-evidence-card" aria-labelledby="reg-evidence-title">
      <div className="reg-evidence-head">
        <div>
          <span className="reg-section-step">2 · 先读证据，不先看答案</span>
          <h3 id="reg-evidence-title">这次运行得到的数值</h3>
        </div>
        <span className="reg-evidence-unit">单位：{REGRESSION_LESSONS[outcome].unit}</span>
      </div>
      {stale && <div className="stale-result">你已经修改了设定；以下数值来自修改前的运行。</div>}
      {support?.suppress_inference && <p role="note">本次停止推断，不能判断效应方向。完整诊断也可作为报告材料；请解释原因，完成理解题后继续下一步。</p>}
      <div className="verdict-metrics">
        <div><span>{verdict.effectLabel}</span><b>{verdict.effect}</b></div>
        <div><span>95% 置信区间</span><b>{verdict.interval}</b></div>
      </div>
      <dl className="reg-evidence-support">
        <div><dt>结果状态</dt><dd>{regressionStatusLabel(response.result.status)}</dd></div>
        <div>
          <dt>处理支持</dt>
          <dd>{support
            ? `${support.treated_clusters} 个处理聚类 · ${support.untreated_clusters} 个完全未暴露聚类`
            : "本次结果未记录支持度"}</dd>
        </div>
      </dl>
      {cohortWeights.length > 0 && (
        <div className="reg-weight-disclosure" role="note">
          <b>总体 ATT 的实际权重（不是 cohort 等权）</b>
          <p>每个 cohort×处理后时期按该单元可用处理实体数计权；早期 cohort 有更多处理后时期，因此同一实体会通过多个时期贡献权重。</p>
          <ul>
            {cohortWeights.map((row) => (
              <li key={row.cohort}>{row.cohort} cohort：{(row.share * 100).toFixed(1)}%（{row.cellCount} 个时期 · {row.treatedEntityPeriods} 个实体×时期）</li>
            ))}
          </ul>
          {dominantCohort && <p><b>主导提醒：</b>{dominantCohort.cohort} cohort 占 {(dominantCohort.share * 100).toFixed(1)}%，所以“总体”结果主要反映该 cohort 的可用处理后时期。</p>}
        </div>
      )}
      <p className="muted">这是四个预先指定结果中的一项。判断顺序：先读效应大小与区间，再确认推断和识别假设；必须报告全部四项，不能只挑区间未跨 0 的结果。</p>
    </section>
  );
}

export function PretrendCheck({ response }: { response: RegressionResponse }) {
  if (response.design.method !== "event_study") return null;
  const diagnostic = response.result.diagnostics.pretrend;
  const globallySuppressed = globalInferenceIsSuppressed(
    response.result.status, response.result.support,
  );
  if (!diagnostic) {
    return globallySuppressed ? (
      <div className="trust-item">
        <b>冲击前趋势联合检查</b>
        <p>{GLOBAL_PRETREND_SUPPRESSION_COPY}</p>
      </div>
    ) : <p>当前响应没有冲击前趋势诊断，不能判断趋势可比性。</p>;
  }
  if (globallySuppressed) {
    return (
      <div className="trust-item">
        <b>冲击前趋势联合检查</b>
        <p>{GLOBAL_PRETREND_SUPPRESSION_COPY}</p>
      </div>
    );
  }
  if (diagnostic.reason === "global_inference_suppressed") {
    return (
      <div className="trust-item">
        <b>冲击前趋势联合检查</b>
        <p>诊断已损坏或状态未知：诊断声称整体推断已抑制，但当前结果并未触发整体门禁；既有统计量与解释不可用。</p>
      </div>
    );
  }
  const scopesAreSafe = response.design.interaction
    ? eventPretrendScopesAreSafe(response.result.event_support, response.result.diagnostics, true)
    : eventMainPretrendContractIsSafe(response.result.event_support, response.result.diagnostics);
  if (
    !eventSupportCoversTerms(
      response.result.event_support,
      response.result.coefs.map((coefficient) => coefficient.name),
      response.design.interaction,
    )
    || !scopesAreSafe
  ) {
    return (
      <div className="trust-item">
        <b>冲击前趋势联合检查</b>
        <p>逐期支持未知或诊断已损坏，旧结果的冲击前趋势统计量与解释不可用于教学推断。</p>
      </div>
    );
  }
  const scoped = response.design.interaction && response.result.diagnostics.pretrend_tests
    ? [
      ["主效应", response.result.diagnostics.pretrend_tests.main],
      ["交互效应", response.result.diagnostics.pretrend_tests.interaction],
      ["联合", response.result.diagnostics.pretrend_tests.joint],
    ] as const
    : [["主效应", diagnostic]] as const;
  return (
    <div className="trust-item">
      <b>冲击前趋势联合检查</b>
      {scoped.map(([label, item]) => item && (
        <div key={label}>
          {response.design.interaction && <b>{label}</b>}
          <p>{item.interpretation}</p>
          {item.available && item.p != null && (
            <>
              <p className="muted">F({item.df_num}, {item.df_denom}) = {item.statistic?.toFixed(3)}，p = {item.p.toFixed(3)} · 有效冲击前时期 {pretrendPeriodCount(item)} 个 · Wald 联合限制 {item.df_num} 条</p>
              <p className="muted">{item.p >= 0.05
                ? pretrendPeriodCount(item) === 1
                  ? "只有一个受支持的冲击前时期，检验力尤其有限；未检出差异不是平行趋势成立的证据。"
                  : "未检出差异也不是平行趋势成立的证据；请结合动态路径和研究背景判断。"
                : pretrendPeriodCount(item) === 1
                  ? "已检出冲击前差异，方向性解读已关闭；且只有一个受支持时期，诊断覆盖仍很窄。"
                  : "已检出冲击前差异，方向性解读已关闭；请结合完整动态路径判断偏离范围。"}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function RegressionPretrendEvidence({ response }: { response: RegressionResponse }) {
  if (response.design.method !== "event_study") return null;
  return (
    <section className="reg-pretrend-card" aria-label="判断前的冲击前趋势证据">
      <span className="reg-section-step">判断前必须检查 · 冲击前趋势</span>
      <PretrendCheck response={response} />
    </section>
  );
}

const signedNumber = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

function marginalNaturalScale(effect: MarginalEffect, response: RegressionResponse) {
  const increment = response.design.method === "twfe_intensity" ? 0.01 : 1;
  const scale = increment * 100; // production 的结果变量是份额，统一换成百分点。
  return {
    effect: effect.effect * scale,
    ciLow: effect.ci_low == null ? null : effect.ci_low * scale,
    ciHigh: effect.ci_high == null ? null : effect.ci_high * scale,
  };
}

export function MarginalEffectsPanel({ response }: { response: RegressionResponse }) {
  const effects = response.result.marginal_effects ?? [];
  if (!response.design.interaction || effects.length === 0) return null;
  const groups = [...new Set(effects.map((effect) => effect.policy_term))];
  return (
    <div className="marginal-effects">
      <div className="marginal-effects-head">
        <div>
          <b>低 / 中 / 高处理前 GVC 的政策边际效应</b>
          <p>处理个体使用首次处理前最后至多两期，从未处理个体使用样本最早两期；分位点按实体等权计算。区间使用主效应、交互项及其协方差，不是把两个系数各自解读。</p>
        </div>
      </div>
      {groups.map((term) => {
        const rows = effects.filter((effect) => effect.policy_term === term);
        const periodGate = response.design.method === "event_study"
          ? eventInferenceGate(response.result.event_support, term)
          : null;
        return (
          <ScrollableRegion className="table-wrap" key={term} label={`${term} 边际效应表，可横向滚动`}>
            {groups.length > 1 && <div className="muted" style={{ margin: "8px 0" }}>政策项：{term}</div>}
            {periodGate && eventInferenceMessage(periodGate, response.result.event_support?.min_contributing_clusters) && (
              <div className="muted" role="note">
                {eventInferenceMessage(periodGate, response.result.event_support?.min_contributing_clusters)}。
                {periodGate.state === "unsupported"
                  ? `${periodGate.period.reasons.join(" ")} 以下边际推断均已抑制。`
                  : "旧结果缺少支持契约，以下边际推断不可用于教学结论。"}
              </div>
            )}
            <table className="data-table">
              <thead><tr><th>处理前 GVC 水平</th><th>相对均值</th><th>边际效应</th><th>95% 置信区间</th><th>p 值</th></tr></thead>
              <tbody>
                {rows.map((effect) => {
                  const scaled = marginalNaturalScale(effect, response);
                  const globallySuppressed = globalInferenceIsSuppressed(
                    response.result.status, response.result.support,
                  );
                  const inferenceAllowed = !globallySuppressed
                    && eventInferenceAllowed(
                      response.design.method, response.result.event_support, effect.policy_term,
                    );
                  const ciLow = inferenceAllowed ? scaled.ciLow : null;
                  const ciHigh = inferenceAllowed ? scaled.ciHigh : null;
                  const p = inferenceAllowed ? effect.p : null;
                  return (
                    <tr key={`${effect.policy_term}-${effect.level}`}>
                      <td><b>{effect.label}</b></td>
                      <td>{signedNumber(effect.baseline_gvc_centered * 100)} pp</td>
                      <td>{signedNumber(scaled.effect)} 个百分点</td>
                      <td>{ciLow == null || ciHigh == null ? "已抑制" : `[${signedNumber(ciLow)}, ${signedNumber(ciHigh)}] pp`}</td>
                      <td>{p == null ? "—" : p.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollableRegion>
        );
      })}
    </div>
  );
}

export function RegressionCoefficientTable({ response }: { response: RegressionResponse }) {
  return (
    <ScrollableRegion className="table-wrap" label="完整回归系数表，可横向滚动">
      <table className="data-table">
        <thead><tr><th>变量</th><th>系数</th><th>95% CI</th><th>聚类SE</th><th>t</th><th>p</th></tr></thead>
        <tbody>{response.result.coefs.map((coef) => {
          const periodGate = response.design.method === "event_study" && coef.name.startsWith("k=")
            ? eventInferenceGate(response.result.event_support, coef.name)
            : null;
          const periodLabel = periodGate
            ? eventInferenceMessage(periodGate, response.result.event_support?.min_contributing_clusters)
            : null;
          const globallySuppressed = globalInferenceIsSuppressed(
            response.result.status, response.result.support,
          );
          const inferenceAllowed = !globallySuppressed
            && eventInferenceAllowed(
              response.design.method, response.result.event_support, coef.name,
            );
          const ciLow = inferenceAllowed ? coef.ci_low : null;
          const ciHigh = inferenceAllowed ? coef.ci_high : null;
          const p = inferenceAllowed ? coef.p : null;
          return (
            // 推断被抑制时留空,不能显示 0 或 NaN；旧事件结果即使携带数值也 fail closed。
            <tr key={coef.name}>
              <td>{coef.name}{periodLabel && <div className="muted">{periodLabel}</div>}</td>
              <td>{coef.coef.toFixed(4)}</td>
              <td>{ciLow != null && ciHigh != null ? `[${ciLow.toFixed(4)}, ${ciHigh.toFixed(4)}]` : periodLabel ?? "—"}</td>
              <td>{coef.se != null ? coef.se.toFixed(4) : "—"}</td><td>{coef.t != null ? coef.t.toFixed(2) : "—"}</td><td>{p != null ? p.toFixed(3) : periodLabel ?? "—"}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </ScrollableRegion>
  );
}

/** 自动保存最近一次真实运行，供刷新恢复与报告复估。 */
export interface SavedRegressionRun {
  settings: RegressionSettings;
  design: RegressionResponse["design"];
  result: RegressionResponse["result"];
}

interface RegressionStepState extends QuizCompletionState, Record<string, unknown> {
  run?: SavedRegressionRun;
  qualified_run?: SavedRegressionRun;
  reading_check?: RegressionReadingCheckState;
}

const SAVED_REGRESSION_BENCHMARK: RegressionResponse["benchmark"] = {
  backend: "saved",
  policy_coefs: [],
  max_abs_coef_diff: 0,
  max_abs_se_diff: 0,
  coef_check_passed: true,
  se_check_mode: "informational",
  notes: [],
};

function savedRegressionResponse(saved: SavedRegressionRun): RegressionResponse {
  return {
    design: saved.design,
    result: saved.result,
    benchmark: SAVED_REGRESSION_BENCHMARK,
    disclaimer: "从实验会话恢复的服务端回归结果",
  };
}

export function regressionSettingsFromSavedDesign(design: RegressionDesignInfo): RegressionSettings {
  return normalizeRegressionSettings({
    granularity: design.granularity,
    shockType: design.shock_type,
    method: design.method,
    controlMode: design.control_mode,
    interaction: design.interaction,
    priceMode: design.price_mode,
    scenario: design.scenario,
    weightMode: design.weight_mode ?? "fixed_pretreatment",
  });
}

function savedDesignSummary(design: RegressionDesignInfo, options: Labels): string {
  return [
    `冲击=${labelOf(options?.shock_type_labels, design.shock_type)}（${design.shock_type}）`,
    `方法=${METHOD_LABELS[design.method] ?? design.method}（${design.method}）`,
    `粒度=${labelOf(options?.granularity_labels, design.granularity)}（${design.granularity}）`,
    `控制=${labelOf(options?.control_mode_labels, design.control_mode)}`,
    `交互=${design.interaction ? "是" : "否"}`,
    `价格口径=${labelOf(options?.price_mode_labels, design.price_mode)}`,
    `场景=${design.scenario_label || SCENARIO_LABELS[design.scenario] || design.scenario}`,
    `暴露权重=${labelOf(options?.weight_mode_labels, design.weight_mode ?? "fixed_pretreatment")}`,
  ].join(" · ");
}

function canonicalSnapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0);
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalSnapshot(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic identity of every saved setting, design field, and result field. */
export function regressionRunSnapshotIdentity(saved: SavedRegressionRun): string {
  return canonicalSnapshot(saved);
}

/** Exact identity check for a candidate run and the server-confirmed step snapshot. */
export function sameQualifiedRegressionSnapshot(
  saved: SavedRegressionRun,
  confirmed: SavedRegressionRun | undefined,
): boolean {
  return confirmed !== undefined
    && regressionRunSnapshotIdentity(saved) === regressionRunSnapshotIdentity(confirmed);
}

export function QualifiedRegressionRunCard({
  saved,
  confirmedSaved,
  options,
  currentSettings,
  sessionSyncing = false,
  sessionUnsynced = false,
  sessionSyncError = null,
  onSwitch,
}: {
  saved: SavedRegressionRun;
  confirmedSaved?: SavedRegressionRun;
  options: Labels;
  currentSettings: RegressionSettings;
  sessionSyncing?: boolean;
  sessionUnsynced?: boolean;
  sessionSyncError?: string | null;
  onSwitch: (settings: RegressionSettings) => void;
}) {
  const response = savedRegressionResponse(saved);
  const verdict = buildRegressionVerdict(saved.design.outcome, response);
  const qualified = isQualifiedRegressionResult(
    saved.result, saved.design.method, saved.design.interaction,
  );
  const usable = qualified;
  const serverConfirmed = usable && sameQualifiedRegressionSnapshot(saved, confirmedSaved);
  const support = saved.result.support;
  const eventTerm = verdict.coefficient?.name.replace("×base_gvc", "") ?? null;
  const eventPeriod = saved.design.method === "event_study" && eventTerm
    ? saved.result.event_support?.periods.find((period) => period.term === eventTerm) ?? null
    : null;
  const signedDesignSettings = regressionSettingsFromSavedDesign(saved.design);
  const sameSettings = regressionSettingsKey(signedDesignSettings) === regressionSettingsKey(currentSettings);
  const cardState = !qualified
    ? "invalid"
    : serverConfirmed
      ? "confirmed"
      : sessionSyncError
        ? "failed"
        : "pending";
  const statusLabel = cardState === "confirmed"
    ? "已由服务器确认"
    : cardState === "pending"
      ? "估计完成，正在保存到第 15 步"
      : cardState === "failed"
        ? "估计完成，但保存失败"
        : "无效的本地回归快照";
  const heading = cardState === "confirmed"
    ? "已保留的可推断回归快照"
    : cardState === "pending" || cardState === "failed"
      ? "正在确认这份回归结果"
      : "这份快照当前不可作推断";
  const qualificationCopy = !qualified
    ? "这份快照不再满足推断门槛；报告主表采用最近一次完整估计或诊断，不把该快照当作可推断结果。"
    : serverConfirmed
      ? `服务器已确认这份对照快照；报告主表采用本步最新完整结果。该快照状态为“${regressionStatusLabel(saved.result.status)}”。`
      : sessionSyncError
        ? "同步失败；第15步不会在服务器确认前使用"
        : sessionSyncing
          ? "估计已经完成，系统正在把完全相同的结果保存到服务器；确认后才会交给第 15 步。"
          : sessionUnsynced
            ? "估计已经完成，正在等待自动保存；服务器确认前第 15 步不会使用。"
            : "估计已经完成，但服务器尚未确认；第 15 步暂不使用。";
  return (
    <details className={`qualified-run-card ${cardState}`}>
      <summary className="qualified-run-summary">
        <span><b>{heading}</b><small>{statusLabel}</small></span>
        <span>{usable ? "已保留一份可报告估计 · 展开查看" : "不可作推断 · 展开查看"}</span>
      </summary>
      <div className="qualified-run-card-head">
        <span className="sr-only" id="qualified-run-title">{heading}</span>
        <button
          type="button"
          className="secondary"
          disabled={sameSettings}
          onClick={() => onSwitch(signedDesignSettings)}
        >
          切换到这套设定
        </button>
      </div>
      <p className="qualified-run-settings">{savedDesignSummary(saved.design, options)}</p>
      <dl className="qualified-run-facts">
        <div><dt>估计对象</dt><dd>{verdict.effectLabel}</dd></div>
        <div><dt>效应</dt><dd>{verdict.effect}</dd></div>
        <div><dt>95% 置信区间</dt><dd>{usable ? verdict.interval : "不显示（不可作推断）"}</dd></div>
        <div>
          <dt>处理支持</dt>
          <dd>{support
            ? [
              `${support.treated_clusters} 个处理聚类`,
              `${support.untreated_clusters} 个未处理聚类`,
              `课程停止线 ${support.min_treated_clusters}（达到不等于自动有效）`,
              `状态=${support.status}`,
              eventPeriod
                ? `${eventPeriod.term}：${eventPeriod.contributing_clusters}/${saved.result.event_support?.min_contributing_clusters} 个贡献聚类`
                : null,
            ].filter(Boolean).join(" · ")
            : "未记录处理支持度"}</dd>
        </div>
      </dl>
      <p
        className="qualified-run-qualification"
        role={cardState === "invalid" || cardState === "failed" ? "alert" : "note"}
      >{qualificationCopy}</p>
      {sameSettings && <p className="muted">当前控件已经是这套设定；如需替换结果，请重新运行。</p>}
    </details>
  );
}

type BoundRequestError = { requestKey: string; message: string };

export function RegressionRequestLoading({ optionsLoading, designLoading }: {
  optionsLoading: boolean;
  designLoading: boolean;
}) {
  if (!optionsLoading && !designLoading) return null;
  const label = optionsLoading && designLoading
    ? "正在读取回归选项与当前模型设计…"
    : optionsLoading ? "正在读取回归选项…" : "正在生成当前模型设计…";
  return <div className="reg-request-state muted" role="status" aria-live="polite" aria-busy="true">{label}</div>;
}

export function RegressionRequestError({ label, error, onRetry }: {
  label: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="error-box async-error" role="alert">
      <span>{userFacingRequestError(error, `${label}失败`)}</span>
      <button type="button" className="secondary" onClick={onRetry}>重试{label}</button>
    </div>
  );
}

export function RegressionRunLab({
  step, settings, onSettingsChange, history, onHistoryChange, state, getStep,
  getConfirmedStep, sessionUnsynced = false, sessionSyncing = false,
  sessionSyncError = null, onNavigateStep,
}: {
  step: Step;
  history: RegressionHistory;
  onHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
  state: StepStateApi<RegressionStepState>;
  getStep?: (step: number) => SiblingStepData | undefined;
  getConfirmedStep?: <T>(step: number) => T | undefined;
  sessionUnsynced?: boolean;
  sessionSyncing?: boolean;
  sessionSyncError?: string | null;
  onNavigateStep?: (step: number) => void;
} & SharedSettingsProps) {
  const outcome = step.regression_outcome;
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const lesson = REGRESSION_LESSONS[outcome];
  const normalizedSettings = normalizeRegressionSettings(settings);
  const { granularity, shockType, method, controlMode, interaction, priceMode, scenario, weightMode } = normalizedSettings;
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [resultSettings, setResultSettings] = useState<RegressionSettings | null>(null);
  const [placebo, setPlacebo] = useState<PlaceboResponse | null>(null);
  const [error, setError] = useState<BoundRequestError | null>(null);
  const [placeboError, setPlaceboError] = useState<BoundRequestError | null>(null);
  const [running, setRunning] = useState(false);
  const [runningRequestKey, setRunningRequestKey] = useState<string | null>(null);
  const [placeboRunning, setPlaceboRunning] = useState(false);
  const [placeboRunningRequestKey, setPlaceboRunningRequestKey] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const placeboRunningRef = useRef(false);
  const placeboRequestRef = useRef(0);
  const runController = useRef<{ key: string; controller: AbortController } | null>(null);
  const placeboController = useRef<{ key: string; controller: AbortController } | null>(null);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const scrollToVerdictAfterRun = useRef(false);
  const latestRequest = useRef(`${outcome}:${regressionSettingsKey(settings)}`);
  const resultSourceIdentity = useRef<string | null>(null);
  const previousSavedRun = useRef<SavedRegressionRun | undefined>(state.data?.run);

  const setSetting = <K extends keyof RegressionSettings>(key: K, value: RegressionSettings[K]) => {
    onSettingsChange(normalizeRegressionSettings({ ...normalizedSettings, [key]: value }));
  };
  const optionsRequestKey = regressionOptionsRequestKey(outcome);
  const optionsQuery = useAsync<RegressionOptions>(
    () => api.regressionOptions(),
    [optionsRequestKey],
    { requestKey: optionsRequestKey },
  );
  const options = optionsQuery.status === "success" ? optionsQuery.data : null;
  // 兜底只决定 options 到达前的请求键，不在加载或失败窗口写回会话。
  // 只有当前 requestKey 的 options 成功后，才可据服务端列表归一化粒度。
  const allowedGranularities = options?.granularities_by_outcome[outcome]
    ?? (outcome === "network" ? ["country_industry"] : ["country_industry", "country"]);
  const effectiveGranularity = allowedGranularities.includes(granularity)
    ? granularity
    : allowedGranularities[0];
  const currentSettings = { ...normalizedSettings, granularity: effectiveGranularity };
  const currentRequestKey = `${outcome}:${regressionSettingsKey(currentSettings)}`;
  latestRequest.current = currentRequestKey;

  useEffect(() => {
    if (optionsQuery.status === "success" && !allowedGranularities.includes(granularity)) {
      setSetting("granularity", allowedGranularities[0]);
    }
  }, [outcome, granularity, optionsQuery.status, options]);

  const designRequestKey = regressionDesignRequestKey(outcome, currentSettings);
  const designQuery = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign({
      outcome, granularity: effectiveGranularity, shockType, method, controlMode, interaction,
      priceMode: controlMode === "none" ? "nominal" : priceMode,
      scenario, weightMode,
    }),
    [designRequestKey],
    { enabled: optionsQuery.status === "success", requestKey: designRequestKey },
  );
  const design = designQuery.status === "success" ? designQuery.data : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      placeboRequestRef.current += 1;
      runController.current?.controller.abort();
      placeboController.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    for (const request of [runController.current, placeboController.current]) {
      if (request && request.key !== currentRequestKey) request.controller.abort();
    }
  }, [currentRequestKey]);

  useEffect(() => {
    scrollToVerdictAfterRun.current = false;
    resultSourceIdentity.current = null;
    previousSavedRun.current = undefined;
    setResult(null);
    setResultSettings(null);
    setPlacebo(null);
    setError(null);
    setPlaceboError(null);
  }, [outcome]);

  // 从实验会话恢复最近一次运行:会话是异步到达的,所以只能用 effect 而不是
  // useState 惰性初始化。刷新或换设备后,学生看到的是自己上次算出的结果,
  // 而不是一个空白的“请运行”面板。设定与结果不一致时 stale 横幅仍会提示。
  const latestSnapshot = (history[outcome] ?? [])[0];
  const savedRun = state.data?.run;
  const savedRunIdentity = savedRun ? regressionRunSnapshotIdentity(savedRun) : null;
  useEffect(() => {
    if (running || runningRef.current) return;

    if (result) {
      if (savedRun && resultSourceIdentity.current === savedRunIdentity) {
        previousSavedRun.current = savedRun;
      }
      return;
    }

    previousSavedRun.current = savedRun;
    if (latestSnapshot) {
      const historyRun = {
        settings: latestSnapshot.settings,
        design: latestSnapshot.response.design,
        result: latestSnapshot.response.result,
      };
      resultSourceIdentity.current = regressionRunSnapshotIdentity(historyRun);
      setResult(latestSnapshot.response);
      setResultSettings(latestSnapshot.settings);
      return;
    }
    if (!savedRun) return;
    resultSourceIdentity.current = savedRunIdentity;
    setResult(savedRegressionResponse(savedRun));
    setResultSettings(savedRun.settings);
  }, [latestSnapshot, result, running, savedRunIdentity]);

  const run = async () => {
    if (runningRef.current || !design) return;
    runningRef.current = true;
    const runSettings = effectiveSettings(currentSettings);
    const requestKey = `${outcome}:${regressionSettingsKey(runSettings)}`;
    const controller = new AbortController();
    runController.current = { key: requestKey, controller };
    setRunning(true);
    setRunningRequestKey(requestKey);
    setError(null);
    // 新主回归开始即使所有在途置换响应失效，避免旧分布覆盖新结果。
    placeboRequestRef.current += 1;
    placeboController.current?.controller.abort();
    placeboRunningRef.current = false;
    setPlaceboRunning(false);
    setPlacebo(null);
    setPlaceboError(null);
    try {
      const response = await api.runRegression(
        outcome, runSettings.granularity, runSettings.shockType, runSettings.method,
        runSettings.controlMode, runSettings.interaction, runSettings.priceMode, runSettings.scenario, runSettings.weightMode,
        controller.signal,
      );
      if (!mountedRef.current) return;
      onHistoryChange((current) => {
        const prior = current[outcome] ?? [];
        const snapshot: RunSnapshot = {
          id: Math.max(0, ...prior.map((item) => item.id)) + 1,
          settings: runSettings,
          response,
        };
        return { ...current, [outcome]: [snapshot, ...prior].slice(0, 3) };
      });
      // 最新完整 run（含不可推断诊断）进入主表；先前可推断快照另存供对照。
      const saved = nextRegressionSave(state.data, {
        settings: runSettings, design: response.design, result: response.result,
      });
      state.save({
        run: saved.run,
        ...(saved.qualified_run ? { qualified_run: saved.qualified_run } : {}),
      });
      if (latestRequest.current === requestKey) {
        const responseRun = {
          settings: runSettings,
          design: response.design,
          result: response.result,
        };
        resultSourceIdentity.current = regressionRunSnapshotIdentity(responseRun);
        scrollToVerdictAfterRun.current = true;
        setResult(response);
        setResultSettings(runSettings);
      }
    } catch (cause) {
      if (mountedRef.current && latestRequest.current === requestKey) {
        setError({ requestKey, message: userFacingRequestError(cause, "回归运行失败") });
      }
    } finally {
      if (runController.current?.controller === controller) runController.current = null;
      runningRef.current = false;
      if (mountedRef.current) {
        setRunning(false);
        setRunningRequestKey(null);
      }
    }
  };

  const stale = Boolean(resultSettings && regressionSettingsKey(resultSettings) !== regressionSettingsKey(currentSettings));

  // 只在学生点运行之后滚到结论。会话恢复也会 setResult，若一并滚动会把页顶的教学卷走。
  useEffect(() => {
    if (!result || !scrollToVerdictAfterRun.current) return;
    scrollToVerdictAfterRun.current = false;
    const frame = window.requestAnimationFrame(() => {
      scrollRegressionVerdict(
        verdictAnchorRef.current,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  const runPlacebo = async () => {
    if (runningRef.current || placeboRunningRef.current || !result || !resultSettings || stale) return;
    placeboRunningRef.current = true;
    const placeboSettings = resultSettings;
    const requestKey = `${outcome}:${regressionSettingsKey(placeboSettings)}`;
    const requestId = ++placeboRequestRef.current;
    const controller = new AbortController();
    placeboController.current = { key: requestKey, controller };
    setPlaceboRunning(true);
    setPlaceboRunningRequestKey(requestKey);
    setPlaceboError(null);
    try {
      const response = await api.placeboRegression(
        outcome, placeboSettings.granularity, placeboSettings.shockType, placeboSettings.method,
        placeboSettings.controlMode, placeboSettings.interaction, placeboSettings.priceMode, placeboSettings.scenario, placeboSettings.weightMode, 40,
        controller.signal,
      );
      if (placeboRequestRef.current === requestId && latestRequest.current === requestKey) {
        setPlacebo(response);
      }
    } catch (cause) {
      if (placeboRequestRef.current === requestId && latestRequest.current === requestKey) {
        setPlaceboError({
          requestKey,
          message: userFacingRequestError(cause, "实体置换敏感性分析失败"),
        });
      }
    } finally {
      if (placeboController.current?.controller === controller) placeboController.current = null;
      if (placeboRequestRef.current === requestId) {
        placeboRunningRef.current = false;
        setPlaceboRunning(false);
        setPlaceboRunningRequestKey(null);
      }
    }
  };

  const currentRunError = error?.requestKey === currentRequestKey ? error.message : null;
  const currentPlaceboError = placeboError?.requestKey === currentRequestKey ? placeboError.message : null;
  const runningCurrentRequest = running && runningRequestKey === currentRequestKey;
  const placeboRunningCurrentRequest = placeboRunning
    && placeboRunningRequestKey === currentRequestKey;
  const settingsDisabled = optionsQuery.status !== "success";
  const split = result ? splitPolicyCoefficients(result) : null;
  const verdict = result ? buildRegressionVerdict(outcome, result) : null;
  const event = result?.design.method === "event_study";
  const display = result ? chartDisplayScale(outcome, result.design.method) : { scale: 1 as number, unit: undefined as string | undefined };
  const snapshots = history[outcome] ?? [];
  const methodLabels = { ...METHOD_LABELS, ...options?.method_labels };
  const resultRun = result && resultSettings
    ? { settings: resultSettings, design: result.design, result: result.result }
    : null;
  const resultIdentity = resultRun ? regressionRunSnapshotIdentity(resultRun) : null;
  const savedReadingCheck = state.data?.reading_check;
  const readingAnswer = resultIdentity && savedReadingCheck?.run_identity === resultIdentity
    ? savedReadingCheck.answer
    : undefined;
  const expectedReadingAnswer = verdict ? readingAnswerForDirection(verdict.state) : null;
  const readingCorrect = Boolean(
    expectedReadingAnswer && readingAnswer === expectedReadingAnswer,
  );

  return (
    <div className="reg-workbench">
      <section className="reg-run-card">
        <span className="reg-section-step">1 · 先运行同一套基准比较</span>
        <h3>{lessonQuestion(outcome, shockType, method)}</h3>
        <div className="metric-facts">
          <span><b>本步指标</b>{lesson.metric}</span>
          <span><b>读数单位</b>{lesson.unit}</span>
          <span><b>比较方法</b>{METHOD_LABELS[method] ?? method}</span>
        </div>
        <div className="reg-boundary">真实 OECD ICIO 指标 + 拟真冲击；默认关税基准用于教学估计，不构成现实政策结论。</div>
        <div className="basic-settings">
          <div><span>冲击</span><Pills label="政策冲击" options={options?.shock_types ?? []} value={shockType} onChange={(value) => setSetting("shockType", value)} labelMap={options?.shock_type_labels} disabled={settingsDisabled} /></div>
        </div>
        <div className="run-summary"><b>当前方案：</b>{settingsSummary(currentSettings, options)}</div>
        <RegressionRequestLoading
          optionsLoading={optionsQuery.status === "loading"}
          designLoading={designQuery.status === "loading"}
        />
        {optionsQuery.status === "error" && optionsQuery.error && (
          <RegressionRequestError label="回归选项" error={optionsQuery.error} onRetry={optionsQuery.retry} />
        )}
        {designQuery.status === "error" && designQuery.error && (
          <RegressionRequestError label="当前模型设计" error={designQuery.error} onRetry={designQuery.retry} />
        )}
        <button
          className="run-btn"
          onClick={run}
          disabled={running || optionsQuery.status !== "success" || designQuery.status !== "success" || !design}
        >
          {/* stale 表示表单已改、结果仍是上一套。 */}
          {runningCurrentRequest
            ? "估计中…"
            : running
              ? "等待上一项估计结束…"
              : stale ? "运行修改后的设定" : result ? "重新运行当前设定" : "运行基准回归"}
        </button>
        {runningCurrentRequest && (
          <span className="muted reg-inline-status" role="status" aria-live="polite" aria-busy="true">正在估计当前设定…</span>
        )}
        <details className="advanced-settings">
          <summary>换冲击、方法或样本口径（选做）</summary>
          <p className="muted">{lesson.guidedExperiment} 三类冲击的支持度不同，见步骤 10；本步主路径默认关税以便比较多国政策路径；撤销和支持不足也是应报告的实验发现。</p>
          <div className="model-controls">
            <div className="model-control"><span className="model-control-label">比较方式</span><Pills label="估计方法" options={options?.methods ?? []} value={method} onChange={(value) => setSetting("method", value)} labelMap={methodLabels} disabled={settingsDisabled} /></div>
            <div className="model-control"><span className="model-control-label">粒度</span><Pills label="分析粒度" options={allowedGranularities} value={effectiveGranularity} onChange={(value) => setSetting("granularity", value)} labelMap={options?.granularity_labels} disabled={settingsDisabled} /></div>
            <div className="model-control"><span className="model-control-label">控制变量</span><Pills label="控制变量" options={options?.control_modes ?? ["none"]} value={controlMode} onChange={(value) => setSetting("controlMode", value)} labelMap={options?.control_mode_labels} disabled /></div>
            <label className="model-control"><span className="model-control-label">异质性</span><input type="checkbox" checked={interaction} disabled={settingsDisabled || method === "did" || method === "event_study"} onChange={(eventValue) => setSetting("interaction", eventValue.target.checked)} />冲击 × 基期GVC</label>
            {controlMode !== "none" && <div className="model-control"><span className="model-control-label">金额类控制口径</span><Pills label="金额类控制口径" options={options?.price_modes ?? []} value={priceMode} onChange={(value) => setSetting("priceMode", value)} labelMap={options?.price_mode_labels} disabled={settingsDisabled} /></div>}
            <div className="model-control"><span className="model-control-label">课堂场景</span><Pills label="课堂场景" options={options?.scenarios ?? []} value={scenario} onChange={(value) => setSetting("scenario", value)} labelMap={SCENARIO_LABELS} disabled={settingsDisabled} /></div>
            <div className="model-control"><span className="model-control-label">冲击暴露权重</span><Pills label="冲击暴露权重" options={(options?.weight_modes ?? ["fixed_pretreatment", "contemporaneous"]).filter((mode) => shockType === "tariff" || mode !== "contemporaneous")} value={weightMode} onChange={(value) => setSetting("weightMode", value)} labelMap={options?.weight_mode_labels ?? { fixed_pretreatment: "首次处理前固定权重（基准）", contemporaneous: "当期贸易权重（稳健性）" }} disabled={settingsDisabled} /></div>
          </div>
          <p className="muted">同期出口、增加值、产业份额和模拟宏观量可能受处理影响，公开主回归不允许把它们当作“遗漏变量控制”；首年增长率也保持缺失而不填 0。</p>
          {(method === "did" || method === "event_study") && <p className="muted">cohort-aware 主结果只发布无交互设定；它按 cohort×时期构造比较，不让已处理 cohort 充当对照。</p>}
          {method !== "did" && <p className="muted">{comparisonExplanation(method)}</p>}
          {scenario !== "clean" && <div className="challenge-note">该场景由系统人为改变估计样本，用于观察测量误差或冲击前趋势如何影响判断；它不是数据筛选条件。</div>}
          {weightMode === "contemporaneous" && <div className="challenge-note">当期贸易结构可能已受政策影响，因此该口径只用于和固定处理前权重对照，不能替代基准识别。</div>}
        </details>
      </section>

      <FamilyMap
        current={outcome}
        history={history}
        getStep={getStep}
        onNavigateStep={onNavigateStep}
        revealCurrent={readingCorrect}
        currentDirection={verdict?.state}
      />

      {state.data?.qualified_run && (
        <QualifiedRegressionRunCard
          saved={state.data.qualified_run}
          confirmedSaved={getConfirmedStep?.<RegressionStepState>(step.n)?.qualified_run}
          options={options}
          currentSettings={currentSettings}
          sessionUnsynced={sessionUnsynced}
          sessionSyncing={sessionSyncing}
          sessionSyncError={sessionSyncError}
          onSwitch={onSettingsChange}
        />
      )}

      {method === "did" && (
        <details className={`reg-compare-card${outcome === "trade" ? " numeric" : ""}`} open={outcome === "trade"}>
          <summary>{outcome === "trade" ? "步骤 11 · 用四格数字理解比较" : "用四格理解当前 ATT 比较（选做复习）"}</summary>
          <div>
            <p>{comparisonExplanation(method)}</p>
            <p className="muted">{lesson.howToRead}</p>
          </div>
          <DidFourCells numeric={outcome === "trade"} />
        </details>
      )}

      <details className="reg-question-card">
        <summary><span className="reg-section-step">理解本步指标与因果边界</span><b>{lesson.focus}</b></summary>
        <div className="reg-question-main">
          <p className="reg-causal-boundary"><b>先记住：</b>这是在平行趋势、对照可比且没有未处理混杂等假设下的相对变化估计，不是“政策已经造成结果”的证明。</p>
          <p className="muted">{REGRESSION_QUESTION}</p>
          <div className="reg-learn-this"><b>本步要学会</b><p>{lesson.learnThis}</p></div>
          <p>{lesson.definition}</p>
          {outcome === "network" && <p className="muted">网络回归只使用全球国家×行业图上的全正边二值介数。微小正边与大额边等长，当前未做边阈值敏感性检验，因此本步只作探索性拓扑证据；国家级贸易图在该口径下为完全图、介数恒为 0。</p>}
          <p><b>下降：</b>{lesson.downMeaning}</p>
          <p><b>上升：</b>{lesson.upMeaning}</p>
          <p><b>跑完记下：</b>{lesson.writeDown}</p>
          <p><b>不要写成：</b>{lesson.dontClaim}</p>
        </div>
      </details>

      {currentRunError && (
        <div className="error-box async-error" role="alert">
          <span>{currentRunError}</span>
          <button type="button" className="secondary" disabled={running || !design} onClick={run}>按当前设定重试</button>
        </div>
      )}

      {result && (
        <div className="reg-results">
          <div ref={verdictAnchorRef} className="verdict-anchor">
            <RegressionEvidenceCard outcome={outcome} response={result} stale={stale} />
          </div>
          <RegressionPretrendEvidence response={result} />
          {state.data?.qualified_run && !isQualifiedRegressionResult(
            result.result, result.design.method, result.design.interaction,
          ) && (
            <p className="muted">本次完整诊断也可写入报告。先前可推断估计保留供核对，不能用它替换或隐藏本次设计限制。</p>
          )}
          {expectedReadingAnswer && resultIdentity && (
            <RegressionReadingCheck
              answer={readingAnswer}
              expected={expectedReadingAnswer}
              stale={stale}
              onAnswer={(answer: RegressionReadingAnswer) => {
                state.save({ reading_check: { run_identity: resultIdentity, answer } });
              }}
            />
          )}
          {readingCorrect && verdict && (
            <>
              <VerdictCard outcome={outcome} response={result} stale={stale} />
              <ReadingCoach
                outcome={outcome}
                direction={verdict.state}
                effect={verdict.effect}
                evidence={verdict.evidence}
                interpretation={verdict.interpretation}
                onNavigateStep={onNavigateStep}
              />
              <SiblingContrast current={outcome} history={history} getStep={getStep} />

              <section className="reg-section-card">
                <span className="reg-section-step">3 · 用图复核，并留到第 15 步和另外三类指标并读</span>
                {result.design.method === "twfe_intensity" && <p className="muted">图与结论卡均展示冲击强度增加 1 个百分点时的结果变化。</p>}
                {event ? (
                  <>
                    <EventStudyChart coefs={split?.eventMain ?? []} notes={result.result.notes} title="主政策变化的动态路径" seriesLabel="主效应 βₖ" pretrend={result.result.diagnostics.pretrend} pretrendDiagnostics={result.result.diagnostics} interaction={result.design.interaction} eventSupport={result.result.event_support} globalSupport={result.result.support} globalStatus={result.result.status} scale={display.scale} unit={display.unit} />
                    {(split?.eventInteraction.length ?? 0) > 0 && <EventStudyChart coefs={split?.eventInteraction ?? []} notes={result.result.notes} title="处理前 GVC 异质性附加变化" seriesLabel="交互效应 θₖ" eventSupport={result.result.event_support} globalSupport={result.result.support} globalStatus={result.result.status} scale={display.scale} unit={display.unit} />}
                  </>
                ) : (
                  <CoefForestChart
                    coefs={split?.policy ?? []}
                    globalStatus={result.result.status}
                    globalSupport={result.result.support}
                    scale={display.scale}
                    unit={display.unit}
                  />
                )}
                {outcome === "production" && (
                  <MarginalEffectsPanel response={result} />
                )}
                <p className="muted">图只展示政策相关系数；加入控制变量后，完整控制项保留在下方技术细节表中。</p>
              </section>

              <details className="reg-section-card">
                <summary>若要进一步检查稳健性</summary>
                {result.design.method === "did" ? (
                  <div className="trust-item">
                    <h3>结果对一种简化的实体置换规则有多敏感？</h3>
                    <p>系统只保留处理实体数量与首次处理年份数量分布，再随机改派实体。它不是安慰剂检验，尾部占比也不是 p 值。</p>
                    <button
                      className="secondary"
                      onClick={runPlacebo}
                      disabled={running || placeboRunning || stale}
                    >
                      {placeboRunningCurrentRequest
                        ? "置换中…"
                        : placeboRunning
                          ? "等待上一项置换结束…"
                          : placebo ? "重新运行实体置换" : "运行实体置换敏感性分析"}
                    </button>
                    {stale && <p className="muted">请先重新运行当前设定，再运行匹配的实体置换。</p>}
                    {placeboRunningCurrentRequest && (
                      <p className="muted" role="status" aria-live="polite" aria-busy="true">正在按当前主回归设定运行实体置换…</p>
                    )}
                    {currentPlaceboError && (
                      <div className="error-box async-error" role="alert">
                        <span>{currentPlaceboError}</span>
                        <button
                          type="button"
                          className="secondary"
                          disabled={running || placeboRunning || stale}
                          onClick={runPlacebo}
                        >
                          按同一设定重试实体置换
                        </button>
                      </div>
                    )}
                    {placebo && !stale && <>
                      <p className="placebo-verdict">{placeboInterpretation(placebo.placebo.tail_share)}</p>
                      <p className="muted">保留：{placebo.placebo.assignment_preserved.join("、")}；未保留：{placebo.placebo.assignment_not_preserved.join("、")}。</p>
                      <PlaceboChart data={placebo.placebo} scale={display.scale} unit={display.unit} />
                    </>}
                  </div>
                ) : <p className="muted">实体置换只用于 DID 教学敏感性分析；它不是校准推断，也不替代 cohort-time ATT。</p>}
              </details>
            </>
          )}
        </div>
      )}

      <details className="technical-details">
        <summary>模型与技术细节</summary>
        {result && stale && <div className="stale-result">以下方程和系数均来自上一次运行；重新运行后才会切换到当前设定。</div>}
        {result?.design ? (
          <DesignEquation design={result.design} />
        ) : designQuery.status === "success" && design ? (
          <DesignEquation design={design} />
        ) : optionsQuery.status === "error" ? (
          <p className="muted">当前方程不可用；请先在上方重试回归选项。</p>
        ) : designQuery.status === "error" ? (
          <p className="muted">当前方程不可用；请在上方重试当前模型设计。</p>
        ) : optionsQuery.status === "loading" ? (
          <p className="muted">正在读取回归选项…</p>
        ) : designQuery.status === "loading" ? (
          <p className="muted">正在生成当前方程…</p>
        ) : null}
        {result && readingCorrect && (
          <>
            <h3>完整系数表</h3>
            <p className="muted">此表为模型原始单位{outcome === "trade" || outcome === "production" ? "（份额为 0–1）" : ""}；上方主图按{display.unit}展示{result.design.method === "twfe_intensity" ? "冲击强度增加 1 个百分点的变化" : "政策效应"}。主效应图只展示政策项。</p>
            <RegressionCoefficientTable response={result} />
            <p className="muted">N={result.result.n_obs.toLocaleString("zh-CN")} · {result.result.n_entities.toLocaleString("zh-CN")} 个体 × {result.result.n_times} 年 · {result.result.n_clusters} 个聚类 · {result.result.r2_within == null ? "cohort-time ATT 不定义组内 R²" : `组内 R²=${result.result.r2_within.toFixed(4)}`}</p>
            <div className="benchmark-box"><b>估计算术一致性检查</b><p>后端：{result.benchmark.backend}；政策系数最大差异 {result.benchmark.max_abs_coef_diff.toExponential(2)}；{result.benchmark.backend === "saved" ? "原运行的算术明细未随会话快照保存" : result.benchmark.benchmark_passed ?? result.benchmark.coef_check_passed ? "系数与标准误算术门禁通过" : result.benchmark.coef_check_passed ? "点估计重聚合通过；整体设计门禁已抑制标准误检查" : "算术检查未通过，结果不可发布"}。cohort-aware DID 重新聚合逐单元点估计，并用 jackknife 伪值公式复算标准误；连续强度 TWFE 使用 PanelOLS 对照。该检查不是独立因果估计器，也不能验证识别假设。</p></div>
            <h3>样本与估计说明</h3>
            {result.result.sample_flow && (
              <p className="muted">
                · 处理时点先由完整冲击历史 {result.result.sample_flow.timing_source_rows.toLocaleString("zh-CN")} 行冻结，
                再从结构合格样本 {result.result.sample_flow.structural_eligible_rows.toLocaleString("zh-CN")} 行筛至估计样本 {result.result.sample_flow.estimation_rows.toLocaleString("zh-CN")} 行；
                因结果/控制缺失或无法配对合计排除 {result.result.sample_flow.dropped_rows_total.toLocaleString("zh-CN")} 行。
              </p>
            )}
            {result.result.notes.map((note) => <p key={note} className="muted">· {note}</p>)}
          </>
        )}
      </details>

      {(!result || readingCorrect) && (
        <RunComparison outcome={outcome} options={options} snapshots={snapshots} onClear={() => onHistoryChange((current) => ({ ...current, [outcome]: [] }))} />
      )}
    </div>
  );
}
