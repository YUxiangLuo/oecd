/**
 * 步骤12-16:回归相关页面(按 prototype 原型重做)。
 *
 * 步骤12 RegDesignLab:交互式设计确认 —— 选择卡即时生成回归方程(GET /api/regression/design),
 *   不影响步骤13-16(各步独立选择,用户确认的取向)。
 * 步骤13-16 RegressionRunLab:模型设定卡(pill 选择 + 方程预览)→ 运行真实回归 →
 *   系数表 + 系数森林图/事件研究图 + 按结果自动生成的中文解读。
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { useAsync } from "./labs";
import { REG_TEACH, interpretResult } from "./regteach";
import { SectionHead, TeachCards } from "./teach";
import type { PlaceboResponse, RegressionDesignInfo, RegressionOptions, RegressionResponse, Step } from "./types";
import { CoefForestChart, EventStudyChart, PlaceboChart } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };
const SCENARIO_HINT: Record<string, string> = {
  clean: "基准场景:冲击数据按当前拟真事件面板进入模型,用于观察标准 DID/FE/事件研究链路。",
  noisy: "测量误差场景:系统给因变量和强度冲击加入确定性噪声,重点观察显著性与置信区间如何变弱。",
  confounded: "前趋势混杂场景:处理组被注入冲击前趋势,事件研究若出现显著 k<0 系数,应判定 DID 识别不可信。",
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

/** 设计摘要行:面板 / 个体 / 聚类(设计端点返回的真实口径) */
function DesignMeta({ d }: { d: RegressionDesignInfo }) {
  const controls = d.controls.length
    ? d.controls.map((c) => d.control_labels[c] ?? c).join("、")
    : "不加控制变量";
  return (
    <div className="design-meta">
      <span>被解释变量:{d.depvar_label}</span>
      <span>冲击:{d.shock_type}({d.method === "双向固定效应" ? d.shock_col : d.treated_col})</span>
      <span>面板:{d.panel_file}</span>
      <span>个体 = {ENTITY_LABEL[d.entity] ?? d.entity}</span>
      <span>标准误按{ENTITY_LABEL[d.cluster] ?? d.cluster}聚类</span>
      <span>控制:{controls}</span>
      <span>交互项:{d.interaction ? "冲击×基期GVC" : "未加入"}</span>
      <span>价格口径:{d.price_mode}</span>
      <span>样本:{d.sample_filter}</span>
      <span>场景:{d.scenario_label}</span>
    </div>
  );
}

/* ------------------------------ 步骤12:设计确认 ------------------------------ */

export function RegDesignLab() {
  const { data: opts, error: optsErr } = useAsync<RegressionOptions>(
    () => api.regressionOptions(), [],
  );
  const [gran, setGran] = useState("国家–行业级");
  const [shock, setShock] = useState("关税冲击");
  const [method, setMethod] = useState("双重差分 (DID)");
  const [controlMode, setControlMode] = useState("不加控制变量");
  const [interaction, setInteraction] = useState(false);
  const [priceMode, setPriceMode] = useState("名义值");
  const [scenario, setScenario] = useState("clean");
  const [depStep, setDepStep] = useState(13);

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
        步骤13–16 可在各自页面上独立调整设计。
      </p>
      <div className="choice-grid">
        <ChoiceCard title="分析粒度" hint="决定冲击数据与 GVC 指标能对齐到多细。">
          <Pills options={opts.granularities} value={gran} onChange={setGran} />
        </ChoiceCard>
        <ChoiceCard title="冲击类型" hint="选择本次实验关注的政策冲击。">
          <Pills options={opts.shock_types} value={shock} onChange={setShock} />
        </ChoiceCard>
        <ChoiceCard title="因果推断方式" hint="有精确时间线才能做 DID / 事件研究。">
          <Pills options={opts.methods} value={method} onChange={setMethod} />
        </ChoiceCard>
        <ChoiceCard title="控制变量" hint="在 ICIO 派生控制与模拟宏观控制之间切换。">
          <Pills
            options={opts.control_modes ?? ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"]}
            value={controlMode}
            onChange={setControlMode}
          />
        </ChoiceCard>
        <ChoiceCard title="异质性" hint="检验基期 GVC 生产份额越高的个体是否更敏感。">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={interaction}
              onChange={(e) => setInteraction(e.target.checked)}
            />
            冲击 × 基期 GVC 生产份额
          </label>
        </ChoiceCard>
        <ChoiceCard title="价格口径" hint="实际值会用 GDP 平减指数调整金额类控制变量。">
          <Pills
            options={opts.price_modes ?? ["名义值", "实际值(2016=1)"]}
            value={priceMode}
            onChange={setPriceMode}
          />
        </ChoiceCard>
        <ChoiceCard title="教学场景" hint="切换测量误差或前趋势混杂,观察识别假设如何失效。">
          <Pills
            options={opts.scenarios ?? ["clean", "noisy", "confounded"]}
            value={scenario}
            onChange={setScenario}
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
      <div className="eq-dark">
        <div className="eq-dark-label">生成的回归方程</div>
        <div className="eq-dark-tex">{design ? design.equation : "…"}</div>
      </div>
      {design && <DesignMeta d={design} />}
    </div>
  );
}

/* --------------------------- 步骤13-16:真实回归 --------------------------- */

export function RegressionRunLab({ step }: { step: Step }) {
  const [gran, setGran] = useState("国家–行业级");
  const [shock, setShock] = useState("关税冲击");
  const [method, setMethod] = useState("双重差分 (DID)");
  const [controlMode, setControlMode] = useState("不加控制变量");
  const [interaction, setInteraction] = useState(false);
  const [priceMode, setPriceMode] = useState("名义值");
  const [scenario, setScenario] = useState("clean");
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [placebo, setPlacebo] = useState<PlaceboResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeboError, setPlaceboError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [placeboRunning, setPlaceboRunning] = useState(false);

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
    setRunning(true);
    setError(null);
    setPlacebo(null);
    setPlaceboError(null);
    try {
      setResult(await api.runRegression(step.n, gran, shock, method, controlMode, interaction, priceMode, scenario));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRunning(false);
    }
  };

  const runPlacebo = async () => {
    setPlaceboRunning(true);
    setPlaceboError(null);
    try {
      setPlacebo(await api.placeboRegression(step.n, gran, shock, method, controlMode, interaction, priceMode, scenario, 40));
    } catch (e) {
      setPlaceboError(String((e as Error).message));
    } finally {
      setPlaceboRunning(false);
    }
  };

  const isEvent = method === "事件研究";
  const policyCoefs = result
    ? result.result.coefs.filter((c) => !result.design.controls.includes(c.name))
    : [];

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
            <Pills options={opts?.granularities ?? ["国家–行业级", "国家级"]} value={gran} onChange={setGran} />
          </div>
          <div className="model-control">
            <span className="model-control-label">冲击</span>
            <Pills options={opts?.shock_types ?? ["关税冲击", "制裁清单", "出口管制"]} value={shock} onChange={setShock} />
          </div>
          <div className="model-control">
            <span className="model-control-label">方法</span>
            <Pills options={opts?.methods ?? ["双重差分 (DID)", "双向固定效应", "事件研究"]} value={method} onChange={setMethod} />
          </div>
          <div className="model-control">
            <span className="model-control-label">控制</span>
            <Pills
              options={opts?.control_modes ?? ["不加控制变量", "ICIO 派生控制变量", "模拟宏观控制"]}
              value={controlMode}
              onChange={setControlMode}
            />
          </div>
          <label className="model-control" style={{ gap: 8 }}>
            <span className="model-control-label">交互</span>
            <input
              type="checkbox"
              checked={interaction}
              onChange={(e) => setInteraction(e.target.checked)}
            />
            <span>冲击×基期GVC</span>
          </label>
          <div className="model-control">
            <span className="model-control-label">口径</span>
            <Pills
              options={opts?.price_modes ?? ["名义值", "实际值(2016=1)"]}
              value={priceMode}
              onChange={setPriceMode}
            />
          </div>
          <div className="model-control">
            <span className="model-control-label">场景</span>
            <Pills
              options={opts?.scenarios ?? ["clean", "noisy", "confounded"]}
              value={scenario}
              onChange={setScenario}
              labelMap={opts?.scenario_labels}
            />
          </div>
        </div>
        <div className="model-eq">{design ? design.equation : "…"}</div>
        {design && <DesignMeta d={design} />}
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
            <EventStudyChart coefs={policyCoefs} notes={result.result.notes} />
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
              <p className="muted">当前教学版安慰剂检验针对 DID 设计;切换到“双重差分 (DID)”后可运行。</p>
            )}
          </div>

          <div className="teach-card reg-interp">
            <div className="teach-label">📋 结果解读(按本次估计自动生成)</div>
            {interpretResult(step.n, result).map((p) => (
              <p key={p.slice(0, 32)}>{p}</p>
            ))}
          </div>

          {result.result.notes.map((n) => <p key={n} className="muted">· {n}</p>)}
        </div>
      )}
    </div>
  );
}
