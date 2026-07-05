import { useEffect, useState } from "react";
import { AUTH_TOKEN_KEY, api } from "./api";
import { LogoMark } from "./brand";
import { IntroOverlay } from "./intro";
import { DbLab, IndicatorLab, QcLab, ReportLab, ShockLab, VizLab } from "./labs";
import { RegDesignLab, RegressionRunLab } from "./regression";
import { LoginPage } from "./login";
import type { AuthUser, Meta, Step, StepsResponse } from "./types";

const ROMAN = ["", "一", "二", "三", "四", "五"];

// 步骤8-11 可视化各自关注的指标列
const VIZ_COLUMNS: Record<number, string[]> = {
  8: ["share_trade_gvc_participation", "share_trade_backward_gvc", "share_trade_forward_gvc", "trade_gross_exports"],
  9: ["share_prod_complex_gvc", "share_prod_simple_gvc", "share_prod_traditional", "share_prod_pure_domestic"],
  10: ["upstreamness", "upstreamness_domestic", "upstreamness_cross"],
  11: ["betweenness_centrality", "degree_centrality", "eigenvector_centrality"],
};

function Lab({ step, meta }: { step: Step; meta: Meta | null }) {
  if (step.lab === "db") return <DbLab />;
  if (step.lab === "qc") return meta ? <QcLab meta={meta} /> : null;
  if (step.lab === "shock") return meta ? <ShockLab meta={meta} /> : null;
  if (step.lab === "ind") return meta ? <IndicatorLab meta={meta} step={step} /> : null;
  if (step.lab === "viz")
    return meta ? <VizLab meta={meta} step={step} columns={VIZ_COLUMNS[step.n] ?? []} /> : null;
  if (step.lab === "rgd") return <RegDesignLab />;
  if (step.lab === "reg") return <RegressionRunLab step={step} />;
  if (step.lab === "rep") return meta ? <ReportLab meta={meta} /> : null;
  return null;
}

export default function App() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  // 支持 ?step=N 深链,便于分享/调试某一步
  const [current, setCurrent] = useState(() => {
    const n = Number(new URLSearchParams(window.location.search).get("step"));
    return n >= 1 && n <= 17 ? n : 4;
  });
  const [fatal, setFatal] = useState<string | null>(null);
  // 认证:localStorage 里的令牌先经 /api/auth/me 真实校验再放行
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) { setAuthChecked(true); return; }
    api.me(token).then(
      (u) => { setUser(u); setAuthChecked(true); },
      () => { localStorage.removeItem(AUTH_TOKEN_KEY); setAuthChecked(true); },
    );
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setStepsData(null);
      setMeta(null);
      setFatal(null);
    };
    window.addEventListener("gvcsim-auth-expired", onExpired);
    return () => window.removeEventListener("gvcsim-auth-expired", onExpired);
  }, []);

  useEffect(() => {
    if (!user) return;
    api.steps().then(setStepsData, (e) => setFatal(String(e.message ?? e)));
    api.meta().then(setMeta, () => setMeta({ years: [], countries: [], sectors: [] }));
  }, [user]);

  if (!authChecked) return <div style={{ padding: 40 }} className="muted">加载中…</div>;
  if (!user)
    return (
      <LoginPage onLogin={(r) => {
        localStorage.setItem(AUTH_TOKEN_KEY, r.token);
        setUser(r.user);
        setShowIntro(true);
      }} />
    );

  if (fatal)
    return (
      <div style={{ padding: 40 }}>
        <div className="error-box">
          无法连接后端 API:{fatal}
          <br />请先启动服务:<code>uv run gvcsim serve</code>
        </div>
      </div>
    );
  if (!stepsData) return <div style={{ padding: 40 }} className="muted">加载中…</div>;

  const steps = stepsData.steps;
  const step = steps.find((s) => s.n === current)!;
  const stages = [...new Set(steps.map((s) => s.stage))];
  const stageName = stepsData.stages[String(step.stage)];
  const prevStep = steps.find((s) => s.n === current - 1);
  const nextStep = steps.find((s) => s.n === current + 1);
  // 回归步骤(rgd/reg)自带完整讲解卡片体系,主区跳过通用讲解卡避免重复
  const isReg = step.lab === "rgd" || step.lab === "reg";

  return (
    <div className="layout">
      <header className="topbar">
        <LogoMark size={30} />
        <div>
          <h1>供应链仿真系统</h1>
          <div className="sub">GVC SIMULATION LAB</div>
        </div>
        <div className="topbar-user">
          <span className="muted">
            数据:OECD ICIO {meta?.years.length ? `${meta.years[0]}–${meta.years.at(-1)}` : "(未预计算)"}
          </span>
          {/* 学习进度:显示当前所处步骤(非已完成数) */}
          <span className="progress-pill">学习进度 <b>{current}</b><span>/17</span></span>
          <span className="role-chip">{user.name}</span>
          <button onClick={() => setShowIntro(true)}>ⓘ 系统介绍</button>
          <button onClick={() => { localStorage.removeItem(AUTH_TOKEN_KEY); setUser(null); }}>退出</button>
        </div>
      </header>

      {showIntro && (
        <IntroOverlay user={user} meta={meta} onDone={(gotoStep) => {
          setShowIntro(false);
          if (gotoStep) setCurrent(gotoStep);
        }} />
      )}

      <div className="main">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="sidebar-head-row">
              <span className="sidebar-title">课程大纲</span>
              <span className="sidebar-steps">17 STEPS</span>
            </div>
            <div className="progress-track">
              <div className="progress-bar" style={{ width: `${Math.max(6, (current / 17) * 100)}%` }} />
            </div>
            <div className="sidebar-sub">全球价值链实证分析 · 数据→指标→回归→报告</div>
          </div>
          <div className="sidebar-list">
          {stages.map((st) => (
            <div key={st}>
              <div className="stage-label">
                <span className="roman">{ROMAN[st]}</span>
                {stepsData.stages[String(st)]}
                <span className="stage-rule" />
              </div>
              {steps.filter((s) => s.stage === st).map((s) => {
                const state = s.n < current ? "past" : s.n === current ? "cur" : "future";
                return (
                  <div
                    key={s.n}
                    className={`step-row${s.n === current ? " active" : ""}`}
                    onClick={() => setCurrent(s.n)}
                  >
                    <span className={`step-badge ${state}`}>{state === "past" ? "✓" : s.n}</span>
                    <span className="step-row-title">{s.title}</span>
                    <span className="step-code">{String(s.n).padStart(2, "0")}</span>
                  </div>
                );
              })}
            </div>
          ))}
          </div>
        </aside>

        <div className="workarea">
          <div className="step-header-bar">
            <div className="big-num">{String(step.n).padStart(2, "0")}</div>
            <div className="step-header-mid">
              <div className="step-header-meta">
                <span className="stage-chip">{stageName}</span>
                <span className="step-count">STEP {step.n} / 17</span>
              </div>
              <h2>{step.title}</h2>
            </div>
            <div className="nav-btns">
              <button disabled={current <= 1} onClick={() => setCurrent(current - 1)}>← 上一步</button>
              <button className="primary" disabled={current >= 17} onClick={() => setCurrent(current + 1)}>下一步 →</button>
            </div>
          </div>

          <div className="content-row">
            <main className="content">
              <div className="content-inner">
                {!isReg && (
                  <div className="card accent">
                    <div className="kicker">讲解</div>
                    <p>{step.concept}</p>
                  </div>
                )}
                <Lab step={step} meta={meta} />
              </div>
            </main>

            <aside className="rightrail">
              <div className="rail-head"><span className="rail-head-ic">📌</span>本步速览</div>
              <div className="rail-stage">
                <div className="rail-stage-loc">阶段{ROMAN[step.stage]} · {stageName}</div>
                <div className="rail-stage-num"><b>{String(step.n).padStart(2, "0")}</b><span>/ 17 步</span></div>
              </div>
              <div className="rail-sec">
                <div className="rail-label">🎯 本步目标</div>
                <div className="rail-goal">{step.goal}</div>
              </div>
              <div className="rail-tip"><span>💡</span><div><b>关键提示 · </b>{step.tip}</div></div>
              <div className="rail-sec">
                <div className="rail-label">🔗 关联数据 / 依赖</div>
                <div className="rail-chips">{step.deps.map((d) => <span key={d} className="rail-chip">{d}</span>)}</div>
              </div>
              <div className="rail-flow">
                <div className="rail-label">流程位置</div>
                {prevStep && (
                  <div className="rail-flow-row" onClick={() => setCurrent(prevStep.n)}>
                    <span className="rail-flow-k">↑ 上一步</span>
                    <span className="rail-flow-t">{prevStep.title}</span>
                  </div>
                )}
                <div className="rail-flow-row cur">
                  <span className="rail-flow-k">● 当前</span>
                  <span className="rail-flow-t">{step.title}</span>
                </div>
                {nextStep && (
                  <div className="rail-flow-row" onClick={() => setCurrent(nextStep.n)}>
                    <span className="rail-flow-k">↓ 下一步</span>
                    <span className="rail-flow-t">{nextStep.title}</span>
                  </div>
                )}
              </div>
            </aside>
          </div>

          <footer className="stepfooter">
            <div className="footer-loc">{stageName} · {step.title}</div>
            <div className="footer-dots">
              {steps.map((s) => (
                <span
                  key={s.n}
                  onClick={() => setCurrent(s.n)}
                  className={`fdot${s.n === current ? " on" : s.n < current ? " past" : ""}`}
                />
              ))}
            </div>
            <div className="footer-next">{nextStep ? `下一步 · ${nextStep.title}` : "已到最后一步"}</div>
          </footer>
        </div>
      </div>
    </div>
  );
}
