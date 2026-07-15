import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAsync } from "./labs";
import { comparisonExplanation, lessonQuestion, REGRESSION_LESSONS } from "./regression-lessons";
import { buildRegressionVerdict, placeboInterpretation } from "./regression-verdict";
import { splitPolicyCoefficients } from "./regteach";
import type {
  PlaceboResponse,
  RegressionDesignInfo,
  RegressionOptions,
  RegressionOutcome,
  RegressionResponse,
  Step,
} from "./types";
import { CoefForestChart, EventStudyChart, PlaceboChart } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
const METHOD_LABELS: Record<string, string> = {
  "双重差分 (DID)": "二元处理 DID",
  双向固定效应: "连续冲击强度",
  事件研究: "动态事件研究",
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
}

export const DEFAULT_REGRESSION_SETTINGS: RegressionSettings = {
  granularity: "国家–行业级",
  shockType: "关税冲击",
  method: "双重差分 (DID)",
  controlMode: "不加控制变量",
  interaction: false,
  priceMode: "名义值",
  scenario: "clean",
};

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
  priceMode: settings.controlMode === "不加控制变量" ? "名义值" : settings.priceMode,
});
const settingsKey = (settings: RegressionSettings) => JSON.stringify(effectiveSettings(settings));

function settingsSummary(settings: RegressionSettings): string {
  return [
    settings.granularity,
    settings.shockType,
    METHOD_LABELS[settings.method] ?? settings.method,
    settings.controlMode,
    settings.interaction ? "含交互" : "无交互",
    settings.controlMode === "不加控制变量" ? null : settings.priceMode,
    SCENARIO_LABELS[settings.scenario] ?? settings.scenario,
  ].filter(Boolean).join(" · ");
}

function changedSettingsSummary(settings: RegressionSettings, snapshots: RunSnapshot[]): string {
  const fields: { key: keyof RegressionSettings; label: string }[] = [
    { key: "granularity", label: "粒度" },
    { key: "shockType", label: "冲击" },
    { key: "method", label: "方法" },
    { key: "controlMode", label: "控制" },
    { key: "interaction", label: "交互" },
    { key: "priceMode", label: "口径" },
    { key: "scenario", label: "场景" },
  ];
  const changed = fields.filter(({ key }) => new Set(snapshots.map((snapshot) => snapshot.settings[key])).size > 1);
  return changed.length
    ? changed.map(({ key, label }) => `${label}=${String(settings[key])}`).join(" · ")
    : "设定相同";
}

function RunComparison({ outcome, snapshots, onClear }: {
  outcome: RegressionOutcome;
  snapshots: RunSnapshot[];
  onClear: () => void;
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
                  <td title={settingsSummary(snapshot.settings)}>运行 {snapshot.id}</td>
                  <td>{changedSettingsSummary(snapshot.settings, snapshots)}</td>
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
      <p className="verdict-boundary">{verdict.boundary}</p>
    </section>
  );
}

function PretrendCheck({ response }: { response: RegressionResponse }) {
  const diagnostic = response.result.diagnostics.pretrend;
  if (response.design.method !== "事件研究") return null;
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

export function RegressionRunLab({ step, settings, onSettingsChange, history, onHistoryChange }: {
  step: Step;
  history: RegressionHistory;
  onHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
} & SharedSettingsProps) {
  const outcome = step.regression_outcome;
  if (!outcome) return <div className="error-box">当前回归步骤缺少 regression_outcome 配置。</div>;
  const lesson = REGRESSION_LESSONS[outcome];
  const { granularity, shockType, method, controlMode, interaction, priceMode, scenario } = settings;
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
  const { data: options, error: optionsError } = useAsync<RegressionOptions>(() => api.regressionOptions(), []);
  const allowedGranularities = options?.granularities_by_outcome[outcome]
    ?? (outcome === "network" ? ["国家–行业级"] : ["国家–行业级", "国家级"]);
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
      priceMode: controlMode === "不加控制变量" ? "名义值" : priceMode,
      scenario,
    }),
    [outcome, effectiveGranularity, shockType, method, controlMode, interaction, priceMode, scenario],
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
        runSettings.controlMode, runSettings.interaction, runSettings.priceMode, runSettings.scenario,
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
        placeboSettings.controlMode, placeboSettings.interaction, placeboSettings.priceMode, placeboSettings.scenario, 40,
      );
      if (placeboRequestRef.current === requestId && latestRequest.current === requestKey) setPlacebo(response);
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
  const event = result?.design.method === "事件研究";
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
        {method === "双重差分 (DID)" && <DidFourCells />}
      </section>

      <section className="reg-run-card">
        <span className="reg-section-step">3 · 运行当前方案</span>
        <div className="reg-boundary">真实 OECD ICIO 指标 + 拟真政策冲击；结果用于教学，不构成现实政策结论。</div>
        <div className="basic-settings">
          <div><span>冲击</span><Pills label="政策冲击" options={options?.shock_types ?? ["关税冲击", "制裁清单", "出口管制"]} value={shockType} onChange={(value) => setSetting("shockType", value)} /></div>
          <div><span>方法</span><Pills label="估计方法" options={options?.methods ?? ["双重差分 (DID)", "双向固定效应", "事件研究"]} value={method} onChange={(value) => setSetting("method", value)} labelMap={METHOD_LABELS} /></div>
          <div><span>粒度</span><Pills label="分析粒度" options={allowedGranularities} value={effectiveGranularity} onChange={(value) => setSetting("granularity", value)} /></div>
        </div>
        {outcome === "network" && (
          <p className="muted">网络回归只使用全球国家×行业图。国家级贸易图在全正流量口径下为完全图，Gephi 介数中心性恒为 0。</p>
        )}

        <details className="advanced-settings">
          <summary>高级设置与课堂挑战</summary>
          <p className="muted">以下选项用于稳健性与识别假设教学，不是开始基准实验的必要条件。</p>
          <div className="model-controls">
            <div className="model-control"><span className="model-control-label">控制变量</span><Pills label="控制变量" options={options?.control_modes ?? ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"]} value={controlMode} onChange={(value) => setSetting("controlMode", value)} /></div>
            <label className="model-control"><span className="model-control-label">异质性</span><input type="checkbox" checked={interaction} onChange={(eventValue) => setSetting("interaction", eventValue.target.checked)} />冲击 × 基期GVC</label>
            {controlMode !== "不加控制变量" && <div className="model-control"><span className="model-control-label">金额类控制口径</span><Pills label="金额类控制口径" options={options?.price_modes ?? ["名义值", "实际值(2016=1)"]} value={priceMode} onChange={(value) => setSetting("priceMode", value)} /></div>}
            <div className="model-control"><span className="model-control-label">课堂场景</span><Pills label="课堂场景" options={options?.scenarios ?? ["clean", "noisy", "confounded"]} value={scenario} onChange={(value) => setSetting("scenario", value)} labelMap={SCENARIO_LABELS} /></div>
          </div>
          {scenario !== "clean" && <div className="challenge-note">该场景由系统人为改变估计样本，用于观察测量误差或冲击前趋势如何影响判断；它不是数据筛选条件。</div>}
        </details>

        {(optionsError || designError) && <div className="error-box">{optionsError ?? designError}</div>}
        <div className="run-summary"><b>当前方案：</b>{settingsSummary(settings)}</div>
        <button className="run-btn" onClick={run} disabled={running || !design || Boolean(optionsError || designError)}>
          {running ? "估计中…" : result ? "重新运行当前设定" : "运行基准回归"}
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
            <p className="muted">图只展示政策相关系数；加入控制变量后，完整控制项保留在下方技术细节表中。</p>
          </section>

          <section className="reg-section-card">
            <span className="reg-section-step">5 · 可信度检查</span>
            <PretrendCheck response={result} />
            {result.design.method === "双重差分 (DID)" ? (
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

          <section className="reg-guide-card">
            <span className="reg-section-step">6 · 下一项引导实验</span>
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
                  <tr key={coef.name}><td>{coef.name}</td><td>{coef.coef.toFixed(4)}</td><td>[{coef.ci_low.toFixed(4)}, {coef.ci_high.toFixed(4)}]</td><td>{coef.se.toFixed(4)}</td><td>{coef.t.toFixed(2)}</td><td>{coef.p.toFixed(3)}</td></tr>
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

      <RunComparison outcome={outcome} snapshots={snapshots} onClear={() => onHistoryChange((current) => ({ ...current, [outcome]: [] }))} />
    </div>
  );
}
