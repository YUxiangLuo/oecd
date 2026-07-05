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
import type { RegressionDesignInfo, RegressionOptions, RegressionResponse, Step } from "./types";
import { CoefForestChart, EventStudyChart } from "./viz";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };

function Pills({ options, value, onChange, readySet }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  /** 传入时,不在集合内的选项显示为禁用的「规划中」 */
  readySet?: Set<string>;
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
            {opt}
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
      <span>面板:{d.panel_file}</span>
      <span>个体 = {ENTITY_LABEL[d.entity] ?? d.entity}</span>
      <span>标准误按{ENTITY_LABEL[d.cluster] ?? d.cluster}聚类</span>
      <span>控制:{controls}</span>
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
  const [depStep, setDepStep] = useState(13);

  const { data: design, error: designErr } = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign({
      step: depStep, granularity: gran, shockType: shock, method, controlMode,
    }),
    [depStep, gran, shock, method, controlMode],
  );

  if (optsErr) return <div className="error-box">{optsErr}</div>;
  if (!opts) return <p className="muted">加载设计选项…</p>;

  const stepEntries = Object.entries(opts.steps).sort(([a], [b]) => Number(a) - Number(b));
  const shockReady = new Set(opts.ready_shock_types ?? ["关税冲击"]);

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
          <Pills options={opts.shock_types} value={shock} onChange={setShock} readySet={shockReady} />
        </ChoiceCard>
        <ChoiceCard title="因果推断方式" hint="有精确时间线才能做 DID / 事件研究。">
          <Pills options={opts.methods} value={method} onChange={setMethod} />
        </ChoiceCard>
        <ChoiceCard title="控制变量" hint="使用现有 ICIO 指标派生国家-年份控制变量。">
          <Pills
            options={opts.control_modes ?? ["不加控制变量", "ICIO 派生控制变量"]}
            value={controlMode}
            onChange={setControlMode}
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
  const [method, setMethod] = useState("双重差分 (DID)");
  const [controlMode, setControlMode] = useState("不加控制变量");
  const [result, setResult] = useState<RegressionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const { data: opts } = useAsync<RegressionOptions>(() => api.regressionOptions(), []);
  const { data: design } = useAsync<RegressionDesignInfo>(
    () => api.regressionDesign({ step: step.n, granularity: gran, method, controlMode }),
    [step.n, gran, method, controlMode],
  );

  // 换步骤/设计时清空旧结果,按钮回到初态
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [step.n, gran, method, controlMode]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.runRegression(step.n, gran, method, controlMode));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRunning(false);
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
            <span className="model-control-label">方法</span>
            <Pills options={opts?.methods ?? ["双重差分 (DID)", "双向固定效应", "事件研究"]} value={method} onChange={setMethod} />
          </div>
          <div className="model-control">
            <span className="model-control-label">控制</span>
            <Pills
              options={opts?.control_modes ?? ["不加控制变量", "ICIO 派生控制变量"]}
              value={controlMode}
              onChange={setControlMode}
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
              <b>{result.benchmark.max_abs_coef_diff.toExponential(2)}</b>,
              标准误最大差异{" "}
              <b>{result.benchmark.max_abs_se_diff.toExponential(2)}</b>
              {result.benchmark.passed ? "。系数对照通过。" : "。请复核对照差异。"}
            </p>
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
