import { useEffect, useRef, useState } from "react";
import { ScrollableRegion } from "./a11y";
import { api } from "./api";
import { useAsync } from "./labs";
import { comparisonExplanation, lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";
import { isQualifiedRegressionResult, nextRegressionSave } from "./regression-save";
import { buildRegressionVerdict, chartDisplayScale, placeboInterpretation } from "./regression-verdict";
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
  did: "双重差分 (DID)",
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
 *  网络用 DID(随后跑非校准实体置换敏感性分析)。学生仍可自由修改,且改动按 outcome 分别保留
 *  (见 App.tsx 里 regression_settings 的 per-outcome 存储)。 */
export const SIGNATURE_SETTINGS: Record<RegressionOutcome, RegressionSettings> = {
  trade: { ...DEFAULT_REGRESSION_SETTINGS },
  production: { ...DEFAULT_REGRESSION_SETTINGS, interaction: false },
  length: { ...DEFAULT_REGRESSION_SETTINGS, method: "event_study" },
  network: { ...DEFAULT_REGRESSION_SETTINGS, granularity: "country_industry" },
};

export function normalizeRegressionSettings(settings: RegressionSettings): RegressionSettings {
  return settings.shockType === "tariff" || settings.weightMode === "fixed_pretreatment"
    ? settings
    : { ...settings, weightMode: "fixed_pretreatment" };
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
      <p className="muted">四格仅用于建立直觉；实际模型是按个体首次处理年构造、含个体与年份固定效应的分期处理 TWFE。</p>
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
          <b>{support.untreated_clusters}</b> 个完全未处理聚类 · 共 {response.result.n_clusters} 个聚类
          （{support.treated_entities} 个曾受冲击实体 · {support.untreated_entities ?? "未记录"} 个从未受冲击实体）
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

function MarginalEffectsPanel({ response }: { response: RegressionResponse }) {
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
        return (
          <ScrollableRegion className="table-wrap" key={term} label={`${term} 边际效应表，可横向滚动`}>
            {groups.length > 1 && <div className="muted" style={{ margin: "8px 0" }}>政策项：{term}</div>}
            <table className="data-table">
              <thead><tr><th>处理前 GVC 水平</th><th>相对均值</th><th>边际效应</th><th>95% 置信区间</th><th>p 值</th></tr></thead>
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
          </ScrollableRegion>
        );
      })}
    </div>
  );
}

/** 自动保存最近一次真实运行，供刷新恢复与报告复估。 */
interface RegressionStepState extends QuizCompletionState, Record<string, unknown> {
  run?: {
    settings: RegressionSettings;
    design: RegressionResponse["design"];
    result: RegressionResponse["result"];
  };
  qualified_run?: {
    settings: RegressionSettings;
    design: RegressionResponse["design"];
    result: RegressionResponse["result"];
  };
}

export function RegressionRunLab({ step, settings, onSettingsChange, history, onHistoryChange, state }: {
  step: Step;
  history: RegressionHistory;
  onHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
  state: StepStateApi<RegressionStepState>;
} & SharedSettingsProps) {
  const outcome = step.regression_outcome;
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const lesson = REGRESSION_LESSONS[outcome];
  const normalizedSettings = normalizeRegressionSettings(settings);
  const { granularity, shockType, method, controlMode, interaction, priceMode, scenario, weightMode } = normalizedSettings;
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
    onSettingsChange(normalizeRegressionSettings({ ...normalizedSettings, [key]: value }));
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
  const currentSettings = { ...normalizedSettings, granularity: effectiveGranularity };
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
    if (result || running) return;
    if (latestSnapshot) {
      setResult(latestSnapshot.response);
      setResultSettings(latestSnapshot.settings);
      return;
    }
    const saved = state.data?.run;
    if (!saved) return;
    setResult({
      design: saved.design,
      result: saved.result,
      benchmark: { backend: "saved", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0, coef_check_passed: true, se_check_mode: "informational", notes: [] },
      disclaimer: "从实验会话恢复的最近一次服务端回归结果",
    });
    setResultSettings(saved.settings);
  }, [latestSnapshot, result, running, state.data?.run]);

  const run = async () => {
    if (runningRef.current || !design) return;
    runningRef.current = true;
    const runSettings = effectiveSettings(currentSettings);
    const requestKey = `${outcome}:${settingsKey(runSettings)}`;
    setRunning(true);
    setError(null);
    // 新主回归开始即使所有在途置换响应失效，避免旧分布覆盖新结果。
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
      // 最近一次 run 供本页恢复；合格快照单独保留，避免不足设计盖掉报告门槛。
      const saved = nextRegressionSave(state.data, {
        settings: runSettings, design: response.design, result: response.result,
      });
      state.save({
        run: saved.run,
        ...(saved.qualified_run ? { qualified_run: saved.qualified_run } : {}),
      });
      if (latestRequest.current === requestKey) {
        setResult(response);
        setResultSettings(runSettings);
      }
    } catch (cause) {
      if (mountedRef.current && latestRequest.current === requestKey) {
        setError(userFacingRequestError(cause, "回归运行失败"));
      }
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
      }
    } catch (cause) {
      if (placeboRequestRef.current === requestId && latestRequest.current === requestKey) {
        setPlaceboError(userFacingRequestError(cause, "实体置换敏感性分析失败"));
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
  const display = result ? chartDisplayScale(outcome, result.design.method) : { scale: 1 as number, unit: undefined as string | undefined };
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

        <div className="comparison-plan">
          <div>
            <b>建议对照实验</b>
            <p>
              {outcome === "trade" && "用完全相同的冲击、方法与粒度，分别运行不加控制和加入 ICIO 派生控制的模型。"}
              {outcome === "production" && "先运行无交互模型，再运行“冲击 × 处理前 GVC”交互模型；交互系数不是平均效应。"}
              {outcome === "length" && "使用事件研究，并检查冲击前联合检验与冲击后的动态路径。"}
              {outcome === "network" && "可在 DID 基准结果后运行非校准实体置换；它只检验结果对这一人为置换规则是否敏感。"}
            </p>
          </div>
          <div className="comparison-actions">
            {outcome === "trade" && <>
              <button type="button" className={controlMode === "none" ? "on" : ""} onClick={() => setSetting("controlMode", "none")}>① 切换到无控制基准</button>
              <button type="button" className={controlMode === "icio_derived" ? "on" : ""} onClick={() => setSetting("controlMode", "icio_derived")}>② 切换到 ICIO 控制</button>
            </>}
            {outcome === "production" && <>
              <button type="button" className={!interaction ? "on" : ""} onClick={() => setSetting("interaction", false)}>① 切换到无交互</button>
              <button type="button" className={interaction ? "on" : ""} onClick={() => setSetting("interaction", true)}>② 打开处理前 GVC 交互</button>
            </>}
            {outcome === "length" && (
              <button type="button" className={method === "event_study" ? "on" : ""} onClick={() => setSetting("method", "event_study")}>使用事件研究</button>
            )}
            {outcome === "network" && (
              <button type="button" className={method === "did" ? "on" : ""} onClick={() => setSetting("method", "did")}>使用 DID + 实体置换</button>
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
            <div className="model-control"><span className="model-control-label">冲击暴露权重</span><Pills label="冲击暴露权重" options={(options?.weight_modes ?? ["fixed_pretreatment", "contemporaneous"]).filter((mode) => shockType === "tariff" || mode !== "contemporaneous")} value={weightMode} onChange={(value) => setSetting("weightMode", value)} labelMap={options?.weight_mode_labels ?? { fixed_pretreatment: "首次处理前固定权重（基准）", contemporaneous: "当期贸易权重（稳健性）" }} /></div>
          </div>
          {scenario !== "clean" && <div className="challenge-note">该场景由系统人为改变估计样本，用于观察测量误差或冲击前趋势如何影响判断；它不是数据筛选条件。</div>}
          {weightMode === "contemporaneous" && <div className="challenge-note">当期贸易结构可能已受政策影响，因此该口径只用于和固定处理前权重对照，不能替代基准识别。</div>}
        </details>

        {(optionsError || designError) && <div className="error-box">{optionsError ?? designError}</div>}
        <div className="run-summary"><b>当前方案：</b>{settingsSummary(currentSettings, options)}</div>
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
          {state.data?.qualified_run && !isQualifiedRegressionResult(result.result) && (
            <p className="muted">本次结果不能作为报告中的有效回归；已保留先前一次可报告的估计。</p>
          )}

          <section className="reg-section-card">
            <span className="reg-section-step">4 · 看效应与不确定性</span>
            {event ? (
              <>
                <EventStudyChart coefs={split?.eventMain ?? []} notes={result.result.notes} title="主政策变化的动态路径" seriesLabel="主效应 βₖ" pretrend={result.result.diagnostics.pretrend} scale={display.scale} unit={display.unit} />
                {(split?.eventInteraction.length ?? 0) > 0 && <EventStudyChart coefs={split?.eventInteraction ?? []} notes={result.result.notes} title="处理前 GVC 异质性附加变化" seriesLabel="交互效应 θₖ" scale={display.scale} unit={display.unit} />}
              </>
            ) : (
              <CoefForestChart
                coefs={split?.policy ?? []}
                scale={display.scale}
                unit={display.unit}
              />
            )}
            {outcome === "production" && (
              <MarginalEffectsPanel response={result} />
            )}
            <p className="muted">图只展示政策相关系数；加入控制变量后，完整控制项保留在下方技术细节表中。</p>
          </section>

          <section className="reg-section-card">
            <span className="reg-section-step">5 · 可信度检查</span>
            <PretrendCheck response={result} />
            {result.design.method === "did" ? (
              <div className="trust-item">
                <h3>结果对一种简化的实体置换规则有多敏感？</h3>
                <p>系统只保留处理实体数量与首次处理年份数量分布，再随机改派实体。它不会保留政策的国家定向、行业资格、事件分配机制或聚类结构，因此不是安慰剂检验或随机化推断。</p>
                <button className="secondary" onClick={runPlacebo} disabled={running || placeboRunning || stale}>
                  {placeboRunning ? "置换中…" : placebo ? "重新运行实体置换" : "运行实体置换敏感性分析"}
                </button>
                {stale && <p className="muted">请先重新运行当前设定，再运行匹配的实体置换。</p>}
                {placeboError && <div className="error-box">{placeboError}</div>}
                {placebo && <>
                  <p className="placebo-verdict">{placeboInterpretation(placebo.placebo.tail_share)}</p>
                  <p className="muted">保留：{placebo.placebo.assignment_preserved.join("、")}；未保留：{placebo.placebo.assignment_not_preserved.join("、")}。</p>
                  <PlaceboChart data={placebo.placebo} scale={display.scale} unit={display.unit} />
                </>}
              </div>
            ) : <p className="muted">当前实体置换只用于双重差分 (DID)；本方法请结合动态路径、控制变量与样本说明判断。</p>}
          </section>

          <section className="reg-section-card">
            <span className="reg-section-step">6 · 继续探索</span>
            {outcome === "length" && (
              <div className={`exploration-status${event ? " done" : ""}`}>
                {event ? "✓ 已展示冲击前联合检验与冲击后动态路径" : "可切换到事件研究，查看冲击前检验和动态路径"}
              </div>
            )}
            {outcome === "production" && (
              <div className={`exploration-status${result.design.interaction && (result.result.marginal_effects?.length ?? 0) > 0 ? " done" : ""}`}>
                {result.design.interaction && (result.result.marginal_effects?.length ?? 0) > 0
                  ? "✓ 已展示低 / 中 / 高处理前 GVC 的边际效应"
                  : "可打开处理前 GVC 交互并运行，查看条件边际效应"}
              </div>
            )}
            {outcome === "network" && (
              <div className={`exploration-status${placebo ? " done" : ""}`}>
                {placebo ? "✓ 已查看非校准实体置换结果" : "可在上方运行实体置换敏感性分析，观察人为改派后的估计分布"}
              </div>
            )}
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
            <p className="muted">此表为模型原始单位{display.unit ? "（份额为 0–1）；上方主图按" + display.unit + "展示" : ""}。主效应图只展示政策项。</p>
            <ScrollableRegion className="table-wrap" label="完整回归系数表，可横向滚动">
              <table className="data-table">
                <thead><tr><th>变量</th><th>系数</th><th>95% CI</th><th>聚类SE</th><th>t</th><th>p</th></tr></thead>
                <tbody>{result.result.coefs.map((coef) => (
                  // 推断被抑制时留空,不能显示 0 或 NaN。
                  <tr key={coef.name}><td>{coef.name}</td><td>{coef.coef.toFixed(4)}</td><td>{coef.ci_low != null && coef.ci_high != null ? `[${coef.ci_low.toFixed(4)}, ${coef.ci_high.toFixed(4)}]` : "—"}</td><td>{coef.se.toFixed(4)}</td><td>{coef.t.toFixed(2)}</td><td>{coef.p != null ? coef.p.toFixed(3) : "—"}</td></tr>
                ))}</tbody>
              </table>
            </ScrollableRegion>
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
