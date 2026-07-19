import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAsync } from "./labs";
import { comparisonExplanation, lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";
import { buildRegressionVerdict, placeboInterpretation } from "./regression-verdict";
import { splitPolicyCoefficients } from "./regteach";
import { CerBox, EvidencePanel, JudgmentBox } from "./step-evidence";
import type {
  CerEvidence,
  EvidenceRules,
  MarginalEffect,
  PlaceboResponse,
  RegressionDesignInfo,
  RegressionOptions,
  RegressionOutcome,
  RegressionResponse,
  Step,
  StepEvidenceApi,
} from "./types";
import { CoefForestChart, EventStudyChart, PlaceboChart } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
// 教学用词:刻意与后端 labels 不同(后端说“双重差分 (DID)”,课堂说“二元处理 DID”)。
// 枚举键稳定之后,界面措辞就是界面自己的事,改它不再是 API 变更。
const METHOD_LABELS: Record<string, string> = {
  did: "二元处理 DID",
  twfe_intensity: "连续冲击强度",
  event_study: "动态事件研究",
};
const SCENARIO_LABELS: Record<string, string> = {
  clean: "基准教学面板",
  noisy: "课堂挑战：人为加入测量噪声",
  confounded: "课堂挑战：人为加入冲击前趋势",
};

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

/** 每步的“招牌默认”:首次进入第 12–15 步时,设定直接落在本步要教的实验上——
 *  贸易看基准 DID(随后加控制),生产先跑无交互基准再开异质性,长度用事件研究,
 *  网络用 DID(随后跑安慰剂)。学生仍可自由修改,且改动按 outcome 分别保留
 *  (见 App.tsx 里 regression_settings 的 per-outcome 存储)。 */
export const SIGNATURE_SETTINGS: Record<RegressionOutcome, RegressionSettings> = {
  trade: { ...DEFAULT_REGRESSION_SETTINGS },
  production: { ...DEFAULT_REGRESSION_SETTINGS, interaction: false },
  length: { ...DEFAULT_REGRESSION_SETTINGS, method: "event_study" },
  network: { ...DEFAULT_REGRESSION_SETTINGS, granularity: "country_industry" },
};

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

function Pills({ options, value, onChange, label, labelMap }: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  labelMap?: Record<string, string>;
}) {
  return (
    <div className="pill-row" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={`pill${value === option ? " on" : ""}`}
          aria-pressed={value === option}
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
      <span>交互：{design.interaction ? "冲击 × 中心化基期 GVC" : "未加入"}</span>
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
      <div className="model-eq" aria-label="当前实际运行方程">
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

const effectiveSettings = (settings: RegressionSettings): RegressionSettings => ({
  ...settings,
  priceMode: settings.controlMode === "none" ? "nominal" : settings.priceMode,
});
const settingsKey = (settings: RegressionSettings) => JSON.stringify(effectiveSettings(settings));

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
      <div className="table-wrap">
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
      </div>
    </section>
  );
}

function DidFourCells() {
  return (
    <div className="did-comparison">
      <table className="did-table" aria-label="双重差分四格比较">
        <thead><tr><th scope="col" /><th scope="col">冲击前</th><th scope="col">冲击后</th></tr></thead>
        <tbody>
          <tr><th scope="row">处理组</th><td>A</td><td>B</td></tr>
          <tr><th scope="row">对照组</th><td>C</td><td>D</td></tr>
        </tbody>
      </table>
      <div className="did-formula">DID =（B−A）−（D−C）</div>
    </div>
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
      <div className="verdict-metrics">
        <div><span>{verdict.effectLabel}</span><b>{verdict.effect}</b></div>
        <div><span>95% 置信区间</span><b>{verdict.interval}</b></div>
      </div>
      <p>{verdict.evidence}</p>
      <p>{verdict.interpretation}</p>
      {support && (
        // 处理支持度必须和结论一起出现:总聚类很多、处理聚类极少,
        // 正是“样本很大所以可信”这一误读的来源。
        <p className="verdict-support">
          处理支持度：<b>{support.treated_clusters}</b> 个处理聚类 ·{" "}
          <b>{support.untreated_clusters}</b> 个对照聚类 · 共 {response.result.n_clusters} 个聚类
          （{support.treated_entities} 个曾受冲击个体）
        </p>
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

function PretrendCheck({ response }: { response: RegressionResponse }) {
  const diagnostic = response.result.diagnostics.pretrend;
  if (response.design.method !== "event_study") return null;
  if (!diagnostic) return <p>当前响应没有冲击前趋势诊断，不能判断趋势可比性。</p>;
  return (
    <div className="trust-item">
      <b>冲击前趋势联合检查</b>
      <p>{diagnostic.interpretation}</p>
      {diagnostic.available && diagnostic.p != null && (
        <p className="muted">F({diagnostic.df_num}, {diagnostic.df_denom}) = {diagnostic.statistic?.toFixed(3)}，p = {diagnostic.p.toFixed(3)}</p>
      )}
    </div>
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

export function marginalEffectEvidenceText(response: RegressionResponse, effects: MarginalEffect[]): string {
  const increment = response.design.method === "twfe_intensity" ? "冲击强度增加 1 个百分点" : "进入处理后";
  return effects.map((effect) => {
    const scaled = marginalNaturalScale(effect, response);
    const interval = scaled.ciLow == null || scaled.ciHigh == null
      ? "推断被抑制，不能报告置信区间"
      : `95% CI [${signedNumber(scaled.ciLow)}, ${signedNumber(scaled.ciHigh)}] 个百分点`;
    return `${effect.label}基期 GVC（相对样本均值 ${signedNumber(effect.baseline_gvc_centered * 100)} 个百分点）时，${increment}的边际效应为 ${signedNumber(scaled.effect)} 个百分点，${interval}`;
  }).join("；") + "。这些边际效应由政策主效应与交互项共同计算，交互系数本身不是平均效应。";
}

function MarginalEffectsPanel({ response, onUse }: {
  response: RegressionResponse;
  onUse: (text: string) => void;
}) {
  const effects = response.result.marginal_effects ?? [];
  if (!response.design.interaction || effects.length === 0) return null;
  const groups = [...new Set(effects.map((effect) => effect.policy_term))];
  return (
    <div className="marginal-effects">
      <div className="marginal-effects-head">
        <div>
          <b>低 / 中 / 高基期 GVC 的政策边际效应</b>
          <p>分位点按样本实体等权计算；区间使用主效应、交互项及其协方差，不是把两个系数各自解读。</p>
        </div>
        <button type="button" className="secondary" onClick={() => onUse(marginalEffectEvidenceText(response, effects))}>将三档数值填入解释</button>
      </div>
      {groups.map((term) => {
        const rows = effects.filter((effect) => effect.policy_term === term);
        return (
          <div className="table-wrap" key={term}>
            {groups.length > 1 && <div className="muted" style={{ margin: "8px 0" }}>政策项：{term}</div>}
            <table className="data-table">
              <thead><tr><th>基期 GVC 水平</th><th>相对均值</th><th>边际效应</th><th>95% 置信区间</th><th>p 值</th></tr></thead>
              <tbody>
                {rows.map((effect) => {
                  const scaled = marginalNaturalScale(effect, response);
                  return (
                    <tr key={`${effect.policy_term}-${effect.level}`}>
                      <td><b>{effect.label}</b></td>
                      <td>{signedNumber(effect.baseline_gvc_centered * 100)} pp</td>
                      <td>{signedNumber(scaled.effect)} 个百分点</td>
                      <td>{scaled.ciLow == null || scaled.ciHigh == null ? "已抑制" : `[${signedNumber(scaled.ciLow)}, ${signedNumber(scaled.ciHigh)}] pp`}</td>
                      <td>{effect.p == null ? "—" : effect.p.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

/** 第 12–15 步的学习证据:跑出结果(动作)+ 写下识别判断(取舍)。 */
interface RegressionEvidence extends Record<string, unknown> {
  run?: { depvar: string; status: string | null; settings: RegressionSettings; run_id?: string };
  run_id?: string;
  placebo_run_id?: string;
  checks?: {
    baseline_run_id?: string;
    controlled_run_id?: string;
    no_interaction_run_id?: string;
    interaction_run_id?: string;
    pretrend?: string;
    post_effect?: string;
    marginal_effect?: string;
  };
  cer?: Partial<CerEvidence>;
  judgment?: string;
}

export function RegressionRunLab({ step, settings, onSettingsChange, history, onHistoryChange, evidence, rules }: {
  step: Step;
  history: RegressionHistory;
  onHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
  evidence: StepEvidenceApi<RegressionEvidence>;
  rules: EvidenceRules;
} & SharedSettingsProps) {
  const outcome = step.regression_outcome;
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const lesson = REGRESSION_LESSONS[outcome];
  const { granularity, shockType, method, controlMode, interaction, priceMode, scenario, weightMode } = settings;
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [resultSettings, setResultSettings] = useState<RegressionSettings | null>(null);
  const [placebo, setPlacebo] = useState<PlaceboResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeboError, setPlaceboError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [placeboRunning, setPlaceboRunning] = useState(false);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const placeboRunningRef = useRef(false);
  const placeboRequestRef = useRef(0);
  const verdictAnchorRef = useRef<HTMLDivElement>(null);
  const latestRequest = useRef(`${outcome}:${settingsKey(settings)}`);

  const setSetting = <K extends keyof RegressionSettings>(key: K, value: RegressionSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };
  const saveCheck = (key: "pretrend" | "post_effect" | "marginal_effect", value: string) => {
    evidence.save({ checks: { ...(evidence.data?.checks ?? {}), [key]: value } });
  };
  const { data: options, error: optionsError } = useAsync<RegressionOptions>(() => api.regressionOptions(), []);
  // 兜底必须用稳定键(与 options.granularities_by_outcome 一致),不能用展示文案:
  // 否则 options 未到时 allowedGranularities.includes(granularity) 恒为 false,会触发
  // 下面的 granularity 归一化 effect 把当前设定(加载窗口里可能是招牌默认)写回会话,
  // 覆盖掉学生已持久化的选择——刷新后设定被重置就是这么来的。
  const allowedGranularities = options?.granularities_by_outcome[outcome]
    ?? (outcome === "network" ? ["country_industry"] : ["country_industry", "country"]);
  const effectiveGranularity = allowedGranularities.includes(granularity)
    ? granularity
    : allowedGranularities[0];
  const currentSettings = { ...settings, granularity: effectiveGranularity };
  latestRequest.current = `${outcome}:${settingsKey(currentSettings)}`;

  useEffect(() => {
    if (!allowedGranularities.includes(granularity)) {
      setSetting("granularity", allowedGranularities[0]);
    }
  }, [outcome, granularity, options]);

  const { data: design, error: designError } = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign({
      outcome, granularity: effectiveGranularity, shockType, method, controlMode, interaction,
      priceMode: controlMode === "none" ? "nominal" : priceMode,
      scenario, weightMode,
    }),
    [outcome, effectiveGranularity, shockType, method, controlMode, interaction, priceMode, scenario, weightMode],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      placeboRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
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
  useEffect(() => {
    if (!latestSnapshot || result || running) return;
    setResult(latestSnapshot.response);
    setResultSettings(latestSnapshot.settings);
  }, [latestSnapshot, result, running]);

  const run = async () => {
    if (runningRef.current || !design) return;
    runningRef.current = true;
    const runSettings = effectiveSettings(currentSettings);
    const requestKey = `${outcome}:${settingsKey(runSettings)}`;
    setRunning(true);
    setError(null);
    // 新主回归开始即使所有在途安慰剂响应失效，避免旧分布覆盖新结果。
    placeboRequestRef.current += 1;
    placeboRunningRef.current = false;
    setPlaceboRunning(false);
    setPlacebo(null);
    setPlaceboError(null);
    try {
      const response = await api.runRegression(
        outcome, runSettings.granularity, runSettings.shockType, runSettings.method,
        runSettings.controlMode, runSettings.interaction, runSettings.priceMode, runSettings.scenario, runSettings.weightMode,
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
      // 学习证据:这一步的“动作”就是真的跑出了一次结果。
      // 记录服务端判定的 status,报告里才能说清这次估计能不能作推断。
      const priorChecks = evidence.data?.checks ?? {};
      const nextChecks = { ...priorChecks };
      if (response.run_id && outcome === "trade") {
        if (runSettings.controlMode === "none") nextChecks.baseline_run_id = response.run_id;
        else nextChecks.controlled_run_id = response.run_id;
      }
      if (response.run_id && outcome === "production") {
        if (runSettings.interaction) nextChecks.interaction_run_id = response.run_id;
        else nextChecks.no_interaction_run_id = response.run_id;
      }
      evidence.save({
        run: { depvar: response.result.depvar, status: response.result.status, settings: runSettings, run_id: response.run_id },
        run_id: response.run_id,
        checks: nextChecks,
      });
      if (latestRequest.current === requestKey) {
        setResult(response);
        setResultSettings(runSettings);
      }
    } catch (cause) {
      if (mountedRef.current && latestRequest.current === requestKey) setError(String((cause as Error).message));
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  const stale = Boolean(resultSettings && settingsKey(resultSettings) !== settingsKey(currentSettings));

  useEffect(() => {
    if (!result) return;
    const frame = window.requestAnimationFrame(() => {
      verdictAnchorRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  const runPlacebo = async () => {
    if (runningRef.current || placeboRunningRef.current || !resultSettings || stale) return;
    placeboRunningRef.current = true;
    const placeboSettings = resultSettings;
    const requestKey = `${outcome}:${settingsKey(placeboSettings)}`;
    const requestId = ++placeboRequestRef.current;
    setPlaceboRunning(true);
    setPlaceboError(null);
    try {
      const response = await api.placeboRegression(
        outcome, placeboSettings.granularity, placeboSettings.shockType, placeboSettings.method,
        placeboSettings.controlMode, placeboSettings.interaction, placeboSettings.priceMode, placeboSettings.scenario, placeboSettings.weightMode, 40,
      );
      if (placeboRequestRef.current === requestId && latestRequest.current === requestKey) {
        setPlacebo(response);
        if (response.placebo_run_id) evidence.save({ placebo_run_id: response.placebo_run_id });
      }
    } catch (cause) {
      if (placeboRequestRef.current === requestId && latestRequest.current === requestKey) {
        setPlaceboError(String((cause as Error).message));
      }
    } finally {
      if (placeboRequestRef.current === requestId) {
        placeboRunningRef.current = false;
        setPlaceboRunning(false);
      }
    }
  };

  const split = result ? splitPolicyCoefficients(result) : null;
  const event = result?.design.method === "event_study";
  const snapshots = history[outcome] ?? [];

  return (
    <div className="reg-workbench">
      <section className="reg-question-card">
        <div className="reg-question-main">
          <span className="reg-section-step">1 · 这一步回答什么</span>
          <h3>{lessonQuestion(outcome, shockType, method)}</h3>
          <p>{lesson.definition}</p>
          <div className="metric-facts">
            <span><b>观察指标</b>{lesson.metric}</span>
            <span><b>解释单位</b>{lesson.unit}</span>
            <span><b>前置知识</b>步骤 {lesson.priorStep} · {lesson.priorLabel}</span>
          </div>
        </div>
        <details className="lesson-details">
          <summary>先理解上升、下降分别可能意味着什么</summary>
          <p><b>下降：</b>{lesson.downMeaning}</p>
          <p><b>上升：</b>{lesson.upMeaning}</p>
          <p><b>注意：</b>{lesson.caution}</p>
        </details>
      </section>

      <section className="reg-compare-card">
        <div>
          <span className="reg-section-step">2 · 谁和谁比较</span>
          <h3>{METHOD_LABELS[method] ?? method}</h3>
          <p>{comparisonExplanation(method)}</p>
        </div>
        {method === "did" && <DidFourCells />}
      </section>

      <section className="reg-run-card">
        <span className="reg-section-step">3 · 运行当前方案</span>
        <div className="reg-boundary">真实 OECD ICIO 指标 + 拟真政策冲击；结果用于教学，不构成现实政策结论。</div>
        <div className="basic-settings">
          <div><span>冲击</span><Pills label="政策冲击" options={options?.shock_types ?? []} value={shockType} onChange={(value) => setSetting("shockType", value)} labelMap={options?.shock_type_labels} /></div>
          <div><span>方法</span><Pills label="估计方法" options={options?.methods ?? []} value={method} onChange={(value) => setSetting("method", value)} labelMap={METHOD_LABELS} /></div>
          <div><span>粒度</span><Pills label="分析粒度" options={allowedGranularities} value={effectiveGranularity} onChange={(value) => setSetting("granularity", value)} labelMap={options?.granularity_labels} /></div>
        </div>
        {outcome === "network" && (
          <p className="muted">网络回归只使用全球国家×行业图。国家级贸易图在全正流量口径下为完全图，Gephi 介数中心性恒为 0。</p>
        )}

        <div className="required-run-plan">
          <div>
            <b>本步必做对照</b>
            <p>
              {outcome === "trade" && "用完全相同的冲击、方法与粒度，分别运行不加控制和加入 ICIO 派生控制的模型。"}
              {outcome === "production" && "先运行无交互模型，再运行“冲击 × 基期 GVC”交互模型；交互系数不是平均效应。"}
              {outcome === "length" && "使用事件研究，并在结果后分别写出一项事前诊断和一项事后动态效应。"}
              {outcome === "network" && "使用 DID 基准结果后必须运行安慰剂检验；随机化尾部位置也不是因果证明。"}
            </p>
          </div>
          <div className="required-run-actions">
            {outcome === "trade" && <>
              <button type="button" className={controlMode === "none" ? "on" : ""} onClick={() => setSetting("controlMode", "none")}>① 切换到无控制基准</button>
              <span className={evidence.data?.checks?.baseline_run_id ? "done" : ""}>{evidence.data?.checks?.baseline_run_id ? "✓ 已运行" : "待运行"}</span>
              <button type="button" className={controlMode === "icio_derived" ? "on" : ""} onClick={() => setSetting("controlMode", "icio_derived")}>② 切换到 ICIO 控制</button>
              <span className={evidence.data?.checks?.controlled_run_id ? "done" : ""}>{evidence.data?.checks?.controlled_run_id ? "✓ 已运行" : "待运行"}</span>
            </>}
            {outcome === "production" && <>
              <button type="button" className={!interaction ? "on" : ""} onClick={() => setSetting("interaction", false)}>① 切换到无交互</button>
              <span className={evidence.data?.checks?.no_interaction_run_id ? "done" : ""}>{evidence.data?.checks?.no_interaction_run_id ? "✓ 已运行" : "待运行"}</span>
              <button type="button" className={interaction ? "on" : ""} onClick={() => setSetting("interaction", true)}>② 打开基期 GVC 交互</button>
              <span className={evidence.data?.checks?.interaction_run_id ? "done" : ""}>{evidence.data?.checks?.interaction_run_id ? "✓ 已运行" : "待运行"}</span>
            </>}
            {outcome === "length" && (
              <button type="button" className={method === "event_study" ? "on" : ""} onClick={() => setSetting("method", "event_study")}>使用事件研究</button>
            )}
            {outcome === "network" && (
              <button type="button" className={method === "did" ? "on" : ""} onClick={() => setSetting("method", "did")}>使用 DID + 安慰剂</button>
            )}
          </div>
        </div>

        <details className="advanced-settings">
          <summary>高级设置与课堂挑战</summary>
          <p className="muted">以下选项用于稳健性与识别假设教学，不是开始基准实验的必要条件。</p>
          <div className="model-controls">
            <div className="model-control"><span className="model-control-label">控制变量</span><Pills label="控制变量" options={options?.control_modes ?? []} value={controlMode} onChange={(value) => setSetting("controlMode", value)} labelMap={options?.control_mode_labels} /></div>
            <label className="model-control"><span className="model-control-label">异质性</span><input type="checkbox" checked={interaction} onChange={(eventValue) => setSetting("interaction", eventValue.target.checked)} />冲击 × 基期GVC</label>
            {controlMode !== "none" && <div className="model-control"><span className="model-control-label">金额类控制口径</span><Pills label="金额类控制口径" options={options?.price_modes ?? []} value={priceMode} onChange={(value) => setSetting("priceMode", value)} labelMap={options?.price_mode_labels} /></div>}
            <div className="model-control"><span className="model-control-label">课堂场景</span><Pills label="课堂场景" options={options?.scenarios ?? []} value={scenario} onChange={(value) => setSetting("scenario", value)} labelMap={SCENARIO_LABELS} /></div>
            <div className="model-control"><span className="model-control-label">冲击暴露权重</span><Pills label="冲击暴露权重" options={options?.weight_modes ?? ["fixed_pretreatment", "contemporaneous"]} value={weightMode} onChange={(value) => setSetting("weightMode", value)} labelMap={options?.weight_mode_labels ?? { fixed_pretreatment: "首次处理前固定权重（基准）", contemporaneous: "当期贸易权重（稳健性）" }} /></div>
          </div>
          {scenario !== "clean" && <div className="challenge-note">该场景由系统人为改变估计样本，用于观察测量误差或冲击前趋势如何影响判断；它不是数据筛选条件。</div>}
          {weightMode === "contemporaneous" && <div className="challenge-note">当期贸易结构可能已受政策影响，因此该口径只用于和固定处理前权重对照，不能替代基准识别。</div>}
        </details>

        {(optionsError || designError) && <div className="error-box">{optionsError ?? designError}</div>}
        <div className="run-summary"><b>当前方案：</b>{settingsSummary(settings, options)}</div>
        <button className="run-btn" onClick={run} disabled={running || !design || Boolean(optionsError || designError)}>
          {/* 改了设定却仍写"重新运行",会让人以为按钮跑的还是上一次那套(点完招牌流程的
              ①/② 后尤其容易误解)。stale 已表示"设定与上次结果不一致",据此分开措辞。 */}
          {running ? "估计中…" : stale ? "运行修改后的设定" : result ? "重新运行当前设定" : "运行基准回归"}
        </button>
      </section>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <div className="reg-results">
          <div ref={verdictAnchorRef} className="verdict-anchor">
            <VerdictCard outcome={outcome} response={result} stale={stale} />
          </div>

          <section className="reg-section-card">
            <span className="reg-section-step">4 · 看效应与不确定性</span>
            {event ? (
              <>
                <EventStudyChart coefs={split?.eventMain ?? []} notes={result.result.notes} title="主政策变化的动态路径" seriesLabel="主效应 βₖ" pretrend={result.result.diagnostics.pretrend} />
                {(split?.eventInteraction.length ?? 0) > 0 && <EventStudyChart coefs={split?.eventInteraction ?? []} notes={result.result.notes} title="基期 GVC 异质性附加变化" seriesLabel="交互效应 θₖ" />}
              </>
            ) : <CoefForestChart coefs={split?.policy ?? []} />}
            {outcome === "production" && (
              <MarginalEffectsPanel response={result} onUse={(text) => saveCheck("marginal_effect", text)} />
            )}
            <p className="muted">图只展示政策相关系数；加入控制变量后，完整控制项保留在下方技术细节表中。</p>
          </section>

          <section className="reg-section-card">
            <span className="reg-section-step">5 · 可信度检查</span>
            <PretrendCheck response={result} />
            {result.design.method === "did" ? (
              <div className="trust-item">
                <h3>这个结果是否可能由随机分组产生？</h3>
                <p>系统随机分配伪处理组并保留首次处理年份分布，再重复估计。它是稳健性检查，不是因果证明。</p>
                <button className="secondary" onClick={runPlacebo} disabled={running || placeboRunning || stale}>
                  {placeboRunning ? "随机化中…" : placebo ? "重新运行安慰剂" : "运行安慰剂检验"}
                </button>
                {stale && <p className="muted">请先重新运行当前设定，再运行匹配的安慰剂检验。</p>}
                {placeboError && <div className="error-box">{placeboError}</div>}
                {placebo && <><p className="placebo-verdict">{placeboInterpretation(placebo.placebo.empirical_p)}</p><PlaceboChart data={placebo.placebo} /></>}
              </div>
            ) : <p className="muted">当前安慰剂随机化只用于二元处理 DID；本方法请结合动态路径、控制变量与样本说明判断。</p>}
          </section>

          <section className="reg-section-card">
            <span className="reg-section-step">6 · 写下你的识别判断</span>
            {outcome === "length" && (
              <div className="diagnostic-evidence-grid">
                <label>
                  <b>事前诊断</b>
                  <span>引用冲击前联合检验或一个冲击前系数，并解释“不显著”能与不能说明什么。</span>
                  <textarea
                    rows={3}
                    value={evidence.data?.checks?.pretrend ?? ""}
                    onChange={(eventValue) => saveCheck("pretrend", eventValue.target.value)}
                    placeholder="例如：冲击前联合检验 p=…；未拒绝零假设只表示未发现明显预趋势……"
                  />
                </label>
                <label>
                  <b>事后动态效应</b>
                  <span>引用一个冲击后期数、系数和置信区间，再解释其经济含义。</span>
                  <textarea
                    rows={3}
                    value={evidence.data?.checks?.post_effect ?? ""}
                    onChange={(eventValue) => saveCheck("post_effect", eventValue.target.value)}
                    placeholder="例如：冲击后第 … 期系数为 …，95% CI 为 […]，与链条…一致。"
                  />
                </label>
              </div>
            )}
            {outcome === "production" && (
              <div className="diagnostic-evidence-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                <label>
                  <b>边际效应解释</b>
                  <span>结合无交互与交互模型，引用低/中/高基期 GVC 中至少一个水平的具体边际效应；不要把交互系数直接当平均效应。</span>
                  <textarea
                    rows={3}
                    value={evidence.data?.checks?.marginal_effect ?? ""}
                    onChange={(eventValue) => saveCheck("marginal_effect", eventValue.target.value)}
                    placeholder="例如：在高基期 GVC（…）时，冲击边际效应为 … 个百分点；它由主效应与交互项共同构成。"
                  />
                </label>
              </div>
            )}
            {outcome === "network" && (
              <>
                <div className={`required-check-status${evidence.data?.placebo_run_id ? " done" : ""}`}>
                  {evidence.data?.placebo_run_id ? "✓ 已保存与当前账号和数据版本绑定的安慰剂结果" : "还需在上方可信度检查中运行安慰剂检验"}
                </div>
                <div className={`required-check-status${/(SUTVA|干扰|相互影响|网络外溢)/i.test(evidence.data?.cer?.boundary ?? "") ? " done" : ""}`}>
                  网络结果的 Boundary 必须讨论 SUTVA、节点相互影响、干扰或网络外溢；一个节点受冲击可能改变其他节点的中心性。
                </div>
              </>
            )}
            <JudgmentBox
              prompt="这次估计的结果,能不能作因果解释?为什么?"
              hint={
                result.result.support?.suppress_inference
                  ? "本次设计已被判定不可作推断——把原因写清楚,比抄一个系数更重要。"
                  : "可以谈:处理组与对照组是否可比、冲击是否外生、处理支持度是否足够、撤销与异质性的影响。"
              }
              minChars={rules.min_judgment_chars}
              value={evidence.data?.judgment ?? ""}
              onChange={(judgment) => evidence.save({ judgment })}
            />
            <CerBox
              title="把回归结果写成可进入报告的 CER"
              value={evidence.data?.cer}
              onChange={(cer) => evidence.save({ cer })}
            />
            <EvidencePanel evidence={evidence} />
          </section>

          <section className="reg-guide-card">
            <span className="reg-section-step">7 · 下一项引导实验</span>
            <h3>{lesson.focus}</h3>
            <p>{lesson.guidedExperiment}</p>
          </section>
        </div>
      )}

      <details className="technical-details">
        <summary>模型与技术细节</summary>
        {result && stale && <div className="stale-result">以下方程和系数均来自上一次运行；重新运行后才会切换到当前设定。</div>}
        {result?.design ? (
          <DesignEquation design={result.design} />
        ) : design ? (
          <DesignEquation design={design} />
        ) : (
          <p className="muted">正在生成当前方程…</p>
        )}
        {result && (
          <>
            <h3>完整系数表</h3>
            <p className="muted">此表包含政策项和控制变量；主效应图只展示政策项。</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>变量</th><th>系数</th><th>95% CI</th><th>聚类SE</th><th>t</th><th>p</th></tr></thead>
                <tbody>{result.result.coefs.map((coef) => (
                  // 推断被抑制时留空,不能显示 0 或 NaN。
                  <tr key={coef.name}><td>{coef.name}</td><td>{coef.coef.toFixed(4)}</td><td>{coef.ci_low != null && coef.ci_high != null ? `[${coef.ci_low.toFixed(4)}, ${coef.ci_high.toFixed(4)}]` : "—"}</td><td>{coef.se.toFixed(4)}</td><td>{coef.t.toFixed(2)}</td><td>{coef.p != null ? coef.p.toFixed(3) : "—"}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <p className="muted">N={result.result.n_obs.toLocaleString("zh-CN")} · {result.result.n_entities.toLocaleString("zh-CN")} 个体 × {result.result.n_times} 年 · {result.result.n_clusters} 个聚类 · 组内 R²={result.result.r2_within.toFixed(4)}</p>
            <div className="benchmark-box"><b>PanelOLS 代码实现一致性检查</b><p>政策系数最大差异 {result.benchmark.max_abs_coef_diff.toExponential(2)}；{result.benchmark.coef_check_passed ? "实现对照通过" : "实现对照需复核"}。这只能检查两套代码结果是否一致，不能验证因果识别。</p></div>
            <h3>样本与估计说明</h3>
            {result.result.notes.map((note) => <p key={note} className="muted">· {note}</p>)}
          </>
        )}
      </details>

      <RunComparison outcome={outcome} options={options} snapshots={snapshots} onClear={() => onHistoryChange((current) => ({ ...current, [outcome]: [] }))} />
    </div>
  );
}
