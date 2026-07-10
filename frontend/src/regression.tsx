/**
 * 步骤12-16:回归相关页面(按 prototype 原型重做)。
 *
 * 步骤12 RegDesignLab:交互式设计确认 —— 选择卡即时生成回归方程(GET /api/regression/design),
 *   设定提升到应用会话并与步骤13-16共用。
 * 步骤13-16 RegressionRunLab:模型设定卡(pill 选择 + 方程预览)→ 运行真实回归 →
 *   系数表 + 系数森林图/事件研究图 + 按结果自动生成的中文解读。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAsync } from "./labs";
import { REG_TEACH, interpretResult, splitPolicyCoefficients } from "./regteach";
import { SectionHead, TeachCards } from "./teach";
import type { PlaceboResponse, RegressionDesignInfo, RegressionOptions, RegressionResponse, Step } from "./types";
import { CoefForestChart, EventStudyChart, PlaceboChart } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
const SCENARIO_HINT: Record<string, string> = {
  clean: "基准场景:冲击数据按当前拟真事件面板进入模型,用于观察标准 DID/FE/事件研究链路。",
  noisy: "测量误差场景:系统给因变量和强度冲击加入确定性噪声,重点观察显著性与置信区间如何变弱。",
  confounded: "前趋势混杂场景:处理组被注入冲击前趋势,事件研究若出现显著 k<0 系数,应判定 DID 识别不可信。",
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

function Pills({ options, value, onChange, readySet, labelMap }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  /** 传入时,不在集合内的选项显示为禁用的「规划中」 */
  readySet?: Set<string>;
  labelMap?: Record<string, string>;
}) {
  return (
    <div className="pill-row">
      {options.map((opt) => {
        const planned = readySet ? !readySet.has(opt) : false;
        return (
          <button
            key={opt}
            className={`pill${value === opt ? " on" : ""}${planned ? " planned" : ""}`}
            disabled={planned}
            onClick={() => onChange(opt)}
          >
            {labelMap?.[opt] ?? opt}
            {planned && <span className="pill-badge">规划中</span>}
          </button>
        );
      })}
    </div>
  );
}

function ChoiceCard({ title, hint, children }: {
  title: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className="choice-card">
      <div className="choice-title">{title}</div>
      <div className="choice-hint">{hint}</div>
      {children}
    </div>
  );
}

/** 设计摘要行:面板 / 个体 / 聚类(设计端点返回的真实口径)。 */
function DesignMeta({ d, activeKey }: { d: RegressionDesignInfo; activeKey?: string | null }) {
  const controls = d.controls.length
    ? d.controls.map((c) => d.control_labels[c] ?? c).join("、")
    : "不加控制变量";
  const item = (key: string, text: string) => (
    <span
      key={key}
      data-meta-key={key}
      style={activeKey === key ? { color: "#4b47e0", background: "#edecfd", borderRadius: 5, padding: "1px 4px", margin: "-1px -4px" } : undefined}
    >
      {text}
    </span>
  );
  return (
    <div className="design-meta">
      {item("depvar", `被解释变量:${d.depvar_label}`)}
      {item("policy", `冲击:${d.shock_type}(${d.method === "双向固定效应" ? d.shock_col : d.treated_col})`)}
      {item("panel", `面板:${d.panel_file}`)}
      {item("entity", `个体 = ${ENTITY_LABEL[d.entity] ?? d.entity}`)}
      {item("cluster", `标准误按${ENTITY_LABEL[d.cluster] ?? d.cluster}聚类`)}
      {item("controls", `控制:${controls}`)}
      {item("interaction", `交互项:${d.interaction ? "冲击×基期GVC" : "未加入"}`)}
      {item("price_mode", `价格口径:${d.price_mode}`)}
      {item("sample", `样本:${d.sample_filter}`)}
      {item("scenario", `场景:${d.scenario_label}`)}
    </div>
  );
}

function DesignEquation({ design, dark = false }: { design: RegressionDesignInfo; dark?: boolean }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeDescription, setActiveDescription] = useState<string | null>(null);
  const parts = design.equation_parts?.length
    ? design.equation_parts
    : [{ text: design.equation }];
  return (
    <>
      <div className={dark ? "eq-dark" : undefined}>
        {dark && <div className="eq-dark-label">生成的回归方程</div>}
        <div className={dark ? "eq-dark-tex" : "model-eq"} aria-label="回归方程">
          {parts.map((part, index) => {
            const interactive = Boolean(part.term || part.description || part.meta_key);
            return (
              <span
                key={`${part.text}-${index}`}
                tabIndex={interactive ? 0 : undefined}
                title={part.description}
                data-equation-term={part.term}
                onMouseEnter={() => { setActiveKey(part.meta_key ?? null); setActiveDescription(part.description ?? null); }}
                onMouseLeave={() => { setActiveKey(null); setActiveDescription(null); }}
                onFocus={() => { setActiveKey(part.meta_key ?? null); setActiveDescription(part.description ?? null); }}
                onBlur={() => { setActiveKey(null); setActiveDescription(null); }}
                style={interactive ? {
                  cursor: "help",
                  borderRadius: 4,
                  outline: "none",
                  background: activeKey && activeKey === part.meta_key ? (dark ? "rgba(129,140,248,.28)" : "#edecfd") : undefined,
                } : undefined}
              >
                {part.text}
              </span>
            );
          })}
        </div>
        {activeDescription && (
          <div role="status" style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: dark ? "#aeb9e8" : "#6b7280" }}>
            {activeDescription}
          </div>
        )}
      </div>
      <DesignMeta d={design} activeKey={activeKey} />
    </>
  );
}

/* ------------------------------ 步骤12:设计确认 ------------------------------ */

export function RegDesignLab({
  settings,
  onSettingsChange,
  onNavigateStep,
}: SharedSettingsProps & { onNavigateStep: (step: number) => void }) {
  const { data: opts, error: optsErr } = useAsync<RegressionOptions>(
    () => api.regressionOptions(), [],
  );
  const [depStep, setDepStep] = useState(13);
  const setSetting = <K extends keyof RegressionSettings>(key: K, value: RegressionSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };
  const { granularity: gran, shockType: shock, method, controlMode, interaction, priceMode, scenario } = settings;

  const { data: design, error: designErr } = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign({
      step: depStep, granularity: gran, shockType: shock, method, controlMode, interaction, priceMode, scenario,
    }),
    [depStep, gran, shock, method, controlMode, interaction, priceMode, scenario],
  );

  if (optsErr) return <div className="error-box">{optsErr}</div>;
  if (!opts) return <p className="muted">加载设计选项…</p>;

  const stepEntries = Object.entries(opts.steps).sort(([a], [b]) => Number(a) - Number(b));

  return (
    <div>
      <TeachCards blocks={REG_TEACH[12]} />
      <SectionHead icon="🧪" label="动手实验 · 生成你的回归设计" />
      <p className="lab-intro">
        在开发回归模块前先对齐三件事,避免做完返工。你的选择会即时生成回归方程;
        这套设定会带到步骤13–16，并在四个回归步骤间共享。
      </p>
      <div className="choice-grid">
        <ChoiceCard title="分析粒度" hint="决定冲击数据与 GVC 指标能对齐到多细。">
          <Pills options={opts.granularities} value={gran} onChange={(value) => setSetting("granularity", value)} />
        </ChoiceCard>
        <ChoiceCard title="冲击类型" hint="选择本次实验关注的政策冲击。">
          <Pills options={opts.shock_types} value={shock} onChange={(value) => setSetting("shockType", value)} />
        </ChoiceCard>
        <ChoiceCard title="因果推断方式" hint="有精确时间线才能做 DID / 事件研究。">
          <Pills options={opts.methods} value={method} onChange={(value) => setSetting("method", value)} />
        </ChoiceCard>
        <ChoiceCard title="控制变量" hint="在 ICIO 派生控制与模拟宏观控制之间切换。">
          <Pills
            options={opts.control_modes ?? ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"]}
            value={controlMode}
            onChange={(value) => setSetting("controlMode", value)}
          />
        </ChoiceCard>
        <ChoiceCard title="异质性" hint="检验基期 GVC 生产份额越高的个体是否更敏感。">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={interaction}
              onChange={(e) => setSetting("interaction", e.target.checked)}
            />
            冲击 × 基期 GVC 生产份额
          </label>
        </ChoiceCard>
        <ChoiceCard title="价格口径" hint="实际值会用 GDP 平减指数调整金额类控制变量。">
          <Pills
            options={opts.price_modes ?? ["名义值", "实际值(2016=1)"]}
            value={priceMode}
            onChange={(value) => setSetting("priceMode", value)}
          />
        </ChoiceCard>
        <ChoiceCard title="教学场景" hint="切换测量误差或前趋势混杂,观察识别假设如何失效。">
          <Pills
            options={opts.scenarios ?? ["clean", "noisy", "confounded"]}
            value={scenario}
            onChange={(value) => setSetting("scenario", value)}
            labelMap={opts.scenario_labels}
          />
        </ChoiceCard>
        <ChoiceCard title="被解释变量" hint="对应步骤13–16 的四组 GVC 指标回归。">
          <div className="pill-row">
            {stepEntries.map(([n, label]) => (
              <button
                key={n}
                className={`pill${depStep === Number(n) ? " on" : ""}`}
                onClick={() => setDepStep(Number(n))}
              >
                {n} · {label}
              </button>
            ))}
          </div>
        </ChoiceCard>
      </div>
      {designErr && <div className="error-box">{designErr}</div>}
      {design ? <DesignEquation design={design} dark /> : <div className="eq-dark"><div className="eq-dark-tex">…</div></div>}
      <button className="run-btn" onClick={() => onNavigateStep(depStep)} disabled={!design}>
        以此设计打开步骤 {depStep}
      </button>
    </div>
  );
}

/* --------------------------- 步骤13-16:真实回归 --------------------------- */

interface RunSnapshot {
  id: number;
  settings: RegressionSettings;
  response: RegressionResponse;
}

const settingsKey = (settings: RegressionSettings) => JSON.stringify(settings);

function settingsSummary(settings: RegressionSettings): string {
  return [
    settings.granularity,
    settings.shockType,
    settings.method,
    settings.controlMode,
    settings.interaction ? "含交互" : "无交互",
    settings.priceMode,
    settings.scenario,
  ].join(" · ");
}

function changedSettingsSummary(settings: RegressionSettings, snapshots: RunSnapshot[]): string {
  if (snapshots.length < 2) return settingsSummary(settings);
  const fields: { key: keyof RegressionSettings; label: string; format?: (value: RegressionSettings[keyof RegressionSettings]) => string }[] = [
    { key: "granularity", label: "粒度" },
    { key: "shockType", label: "冲击" },
    { key: "method", label: "方法" },
    { key: "controlMode", label: "控制" },
    { key: "interaction", label: "交互", format: (value) => value ? "开启" : "关闭" },
    { key: "priceMode", label: "口径" },
    { key: "scenario", label: "场景" },
  ];
  const changed = fields.filter(({ key }) => new Set(snapshots.map((snapshot) => snapshot.settings[key])).size > 1);
  if (changed.length === 0) return "设定未变（重复运行）";
  return changed.map(({ key, label, format }) => {
    const value = settings[key];
    return `${label}=${format ? format(value) : String(value)}`;
  }).join(" · ");
}

function RunComparison({ snapshots, onClear }: { snapshots: RunSnapshot[]; onClear: () => void }) {
  if (snapshots.length === 0) return null;
  const coefficientNames = [...new Set(snapshots.flatMap(({ response }) => (
    splitPolicyCoefficients(response).policy.map((coef) => coef.name)
  )))];
  return (
    <div className="benchmark-box" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div className="teach-label">最近运行对比（最多 3 次）</div>
        <button className="secondary" onClick={onClear}>清空</button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>政策系数</th>
              {snapshots.map((snapshot, index) => (
                <th key={snapshot.id} title={settingsSummary(snapshot.settings)}>
                  运行 {snapshots.length - index}
                  <small style={{ display: "block", maxWidth: 180, whiteSpace: "normal", color: "#8a90a0", fontWeight: 400 }}>
                    {changedSettingsSummary(snapshot.settings, snapshots)}
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {coefficientNames.map((name) => (
              <tr key={name}>
                <td>{name}</td>
                {snapshots.map((snapshot) => {
                  const coef = splitPolicyCoefficients(snapshot.response).policy.find((item) => item.name === name);
                  return <td key={snapshot.id}>{coef ? `${coef.coef >= 0 ? "+" : ""}${coef.coef.toFixed(4)}${coef.stars}` : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RegressionRunLab({ step, settings, onSettingsChange }: { step: Step } & SharedSettingsProps) {
  const { granularity: gran, shockType: shock, method, controlMode, interaction, priceMode, scenario } = settings;
  const setSetting = <K extends keyof RegressionSettings>(key: K, value: RegressionSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [placebo, setPlacebo] = useState<PlaceboResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeboError, setPlaceboError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [placeboRunning, setPlaceboRunning] = useState(false);
  const [history, setHistory] = useState<Record<number, RunSnapshot[]>>({});
  const nextRunId = useRef(1);
  const runningRef = useRef(false);
  const placeboRunningRef = useRef(false);
  const latestRequest = useRef(`${step.n}:${settingsKey(settings)}`);
  latestRequest.current = `${step.n}:${settingsKey(settings)}`;

  const { data: opts } = useAsync<RegressionOptions>(() => api.regressionOptions(), []);
  const { data: design } = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign({ step: step.n, granularity: gran, shockType: shock, method, controlMode, interaction, priceMode, scenario }),
    [step.n, gran, shock, method, controlMode, interaction, priceMode, scenario],
  );

  // 换步骤/设计时清空旧结果,按钮回到初态
  useEffect(() => {
    setResult(null);
    setPlacebo(null);
    setError(null);
    setPlaceboError(null);
  }, [step.n, gran, shock, method, controlMode, interaction, priceMode, scenario]);

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const runSettings = { ...settings };
    const requestKey = `${step.n}:${settingsKey(runSettings)}`;
    setRunning(true);
    setError(null);
    setPlacebo(null);
    setPlaceboError(null);
    try {
      const response = await api.runRegression(
        step.n,
        runSettings.granularity,
        runSettings.shockType,
        runSettings.method,
        runSettings.controlMode,
        runSettings.interaction,
        runSettings.priceMode,
        runSettings.scenario,
      );
      const snapshot: RunSnapshot = { id: nextRunId.current++, settings: runSettings, response };
      setHistory((current) => ({
        ...current,
        [step.n]: [snapshot, ...(current[step.n] ?? [])].slice(0, 3),
      }));
      if (latestRequest.current === requestKey) setResult(response);
    } catch (e) {
      if (latestRequest.current === requestKey) setError(String((e as Error).message));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const runPlacebo = async () => {
    if (placeboRunningRef.current) return;
    placeboRunningRef.current = true;
    const requestKey = `${step.n}:${settingsKey(settings)}`;
    setPlaceboRunning(true);
    setPlaceboError(null);
    try {
      const response = await api.placeboRegression(step.n, gran, shock, method, controlMode, interaction, priceMode, scenario, 40);
      if (latestRequest.current === requestKey) setPlacebo(response);
    } catch (e) {
      if (latestRequest.current === requestKey) setPlaceboError(String((e as Error).message));
    } finally {
      placeboRunningRef.current = false;
      setPlaceboRunning(false);
    }
  };

  const isEvent = (result?.design.method ?? method) === "事件研究";
  const splitCoefs = result ? splitPolicyCoefficients(result) : null;
  const policyCoefs = splitCoefs?.policy ?? [];
  const eventMainCoefs = splitCoefs?.eventMain ?? [];
  const eventInteractionCoefs = splitCoefs?.eventInteraction ?? [];

  return (
    <div>
      <TeachCards blocks={REG_TEACH[step.n] ?? []} />
      <SectionHead icon="🧪" label="动手实验 · 运行真实回归" />
      <div className="warnbox">
        ⚠ 冲击变量为<b>拟真演示面板</b>(以 2018–2020 全球贸易摩擦为原型,覆盖全部经济体、行业异质),仅用于验证系统链路;接入 PIIE/WTO 真实数据后才具研究意义。
      </div>

      <div className="model-card">
        <div className="teach-label">模型设定</div>
        <div className="model-controls">
          <div className="model-control">
            <span className="model-control-label">粒度</span>
            <Pills options={opts?.granularities ?? ["国家–行业级", "国家级"]} value={gran} onChange={(value) => setSetting("granularity", value)} />
          </div>
          <div className="model-control">
            <span className="model-control-label">冲击</span>
            <Pills options={opts?.shock_types ?? ["关税冲击", "制裁清单", "出口管制"]} value={shock} onChange={(value) => setSetting("shockType", value)} />
          </div>
          <div className="model-control">
            <span className="model-control-label">方法</span>
            <Pills options={opts?.methods ?? ["双重差分 (DID)", "双向固定效应", "事件研究"]} value={method} onChange={(value) => setSetting("method", value)} />
          </div>
          <div className="model-control">
            <span className="model-control-label">控制</span>
            <Pills
              options={opts?.control_modes ?? ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"]}
              value={controlMode}
              onChange={(value) => setSetting("controlMode", value)}
            />
          </div>
          <label className="model-control" style={{ gap: 8 }}>
            <span className="model-control-label">交互</span>
            <input
              type="checkbox"
              checked={interaction}
              onChange={(e) => setSetting("interaction", e.target.checked)}
            />
            <span>冲击×基期GVC</span>
          </label>
          <div className="model-control">
            <span className="model-control-label">口径</span>
            <Pills
              options={opts?.price_modes ?? ["名义值", "实际值(2016=1)"]}
              value={priceMode}
              onChange={(value) => setSetting("priceMode", value)}
            />
          </div>
          <div className="model-control">
            <span className="model-control-label">场景</span>
            <Pills
              options={opts?.scenarios ?? ["clean", "noisy", "confounded"]}
              value={scenario}
              onChange={(value) => setSetting("scenario", value)}
              labelMap={opts?.scenario_labels}
            />
          </div>
        </div>
        {design ? <DesignEquation design={design} /> : <div className="model-eq">…</div>}
        <div className="benchmark-box" style={{ margin: "0 0 12px" }}>
          <div className="teach-label">运行前预期</div>
          <p>{SCENARIO_HINT[scenario] ?? scenario}</p>
        </div>
        <button
          className={`run-btn${result ? " done" : ""}`}
          onClick={run}
          disabled={running}
        >
          {running ? "估计中…" : result ? "✓ 回归完成" : "▶ 运行回归"}
        </button>
      </div>

      {error && <div className="error-box" style={{ marginTop: 14 }}>{error}</div>}

      {result && (
        <div className="reg-results">
          <div className="reg-results-row">
            <div className="reg-table-col">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th>变量</th><th>系数</th><th>聚类标准误</th><th>t</th><th>p</th><th>显著</th></tr>
                  </thead>
                  <tbody>
                    {result.result.coefs.map((c) => (
                      <tr key={c.name}>
                        <td className={c.stars ? "coef-name-sig" : "coef-name"}>{c.name}</td>
                        <td className={c.coef < 0 ? "coef-neg" : "coef-pos"}>
                          {c.coef >= 0 ? "+" : ""}{c.coef.toFixed(4)}
                        </td>
                        <td className="coef-se">{c.se.toFixed(4)}</td>
                        <td>{c.t.toFixed(2)}</td>
                        <td>{c.p.toFixed(3)}</td>
                        <td className="coef-stars">{c.stars}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ marginTop: 8 }}>
                N = {result.result.n_obs.toLocaleString("zh-CN")} · {result.result.n_entities.toLocaleString("zh-CN")} 个体 × {result.result.n_times} 年 · {result.result.n_clusters} 个聚类 · 组内 R² = {result.result.r2_within.toFixed(4)} · 固定效应 ✓
              </p>
            </div>
            {!isEvent && <CoefForestChart coefs={policyCoefs} />}
          </div>

          {isEvent && (
            <>
              <EventStudyChart
                coefs={eventMainCoefs}
                notes={result.result.notes}
                title="事件研究：主政策效应的动态路径"
                seriesLabel="主效应 βₖ"
              />
              {eventInteractionCoefs.length > 0 && (
                <EventStudyChart
                  coefs={eventInteractionCoefs}
                  notes={result.result.notes}
                  title="异质性：基期 GVC 暴露的动态附加效应"
                  seriesLabel="交互效应 θₖ"
                />
              )}
            </>
          )}

          <div className="benchmark-box">
            <div className="teach-label">标准库对照</div>
            <p>
              {result.benchmark.backend}:政策系数最大差异{" "}
              <b>{result.benchmark.max_abs_coef_diff.toExponential(2)}</b>
              {result.benchmark.coef_check_passed
                ? "，政策系数对照通过。"
                : "，政策系数对照未通过,请复核。"}
              标准误最大差异{" "}
              <b>{result.benchmark.max_abs_se_diff.toExponential(2)}</b>，
              仅作参考(不同实现的小样本/自由度修正规则可能不同)。
            </p>
          </div>

          <div className="benchmark-box">
            <div className="teach-label">教学场景判读</div>
            <p>{SCENARIO_HINT[result.design.scenario] ?? result.design.scenario_label}</p>
          </div>

          <div className="benchmark-box">
            <div className="teach-label">安慰剂检验</div>
            {method === "双重差分 (DID)" ? (
              <>
                <p>
                  随机抽取同等数量的伪处理个体,并保留原始首次处理年份(cohort)分布后重跑 DID;
                  如果真系数落在伪分布尾部,说明估计结果不像随机分组偶然产生。
                </p>
                <button className="run-btn" onClick={runPlacebo} disabled={placeboRunning}>
                  {placeboRunning ? "随机化中…" : placebo ? "重新运行安慰剂检验" : "运行安慰剂检验"}
                </button>
                {placeboError && <div className="error-box" style={{ marginTop: 12 }}>{placeboError}</div>}
                {placebo && <PlaceboChart data={placebo.placebo} />}
              </>
            ) : (
              <p className="muted">
                当前教学版安慰剂检验只针对 DID：它通过随机重排处理组、保留 cohort 分布来构造伪 ATT。
                当前方法的政策量或逐期动态系数没有同一个单一 ATT，因此不能直接套用这项随机化检验；
                切换到“双重差分 (DID)”后可运行。
              </p>
            )}
          </div>

          <div className="teach-card reg-interp">
            <div className="teach-label">📋 结果解读(按本次估计自动生成)</div>
            {interpretResult(step.n, result).map((p) => (
              <p key={p.slice(0, 32)}>{p}</p>
            ))}
          </div>

          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>样本与估计说明（{result.result.notes.length} 条）</summary>
            <div style={{ padding: "4px 0 0 12px" }}>
              {result.result.notes.map((n) => <p key={n} className="muted">· {n}</p>)}
            </div>
          </details>
        </div>
      )}
      <RunComparison
        snapshots={history[step.n] ?? []}
        onClear={() => setHistory((current) => ({ ...current, [step.n]: [] }))}
      />
    </div>
  );
}
