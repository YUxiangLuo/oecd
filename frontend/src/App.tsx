import { useCallback, useEffect, useRef, useState } from "react";
import { scanAnnouncements } from "./announcement-state";
import { AUTH_TOKEN_KEY, api } from "./api";
import { LogoMark } from "./brand";
import { IntroOverlay } from "./intro";
import { DbLab, IndicatorLab, QcLab, ReportLab, ShockLab, VizLab } from "./labs";
import {
  DEFAULT_REGRESSION_SETTINGS,
  RegDesignLab,
  RegressionRunLab,
  type RegressionHistory,
  type RegressionSettings,
} from "./regression";
import { LoginPage } from "./login";
import { TeacherDashboard } from "./teacher";
import { ToastHost } from "./toast";
import type { Announcement, AuthUser, Meta, Step, StepsResponse } from "./types";

const ROMAN = ["", "一", "二", "三", "四", "五"];

function stepFromUrl(): number | null {
  const n = Number(new URLSearchParams(window.location.search).get("step"));
  return Number.isInteger(n) && n >= 1 && n <= 17 ? n : null;
}

function Lab({ step, meta, regressionSettings, onRegressionSettingsChange, regressionHistory, onRegressionHistoryChange, onNavigateStep }: {
  step: Step;
  meta: Meta | null;
  regressionSettings: RegressionSettings;
  onRegressionSettingsChange: (settings: RegressionSettings) => void;
  regressionHistory: RegressionHistory;
  onRegressionHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
  onNavigateStep: (step: number) => void;
}) {
  if (step.lab === "db") return <DbLab />;
  if (step.lab === "qc") return meta ? <QcLab meta={meta} onNavigateStep={onNavigateStep} /> : null;
  if (step.lab === "shock") return meta ? <ShockLab meta={meta} /> : null;
  if (step.lab === "ind") return meta ? <IndicatorLab meta={meta} step={step} /> : null;
  if (step.lab === "viz")
    return meta ? <VizLab key={step.n} meta={meta} step={step} /> : null;
  if (step.lab === "rgd") return (
    <RegDesignLab
      settings={regressionSettings}
      onSettingsChange={onRegressionSettingsChange}
      onNavigateStep={onNavigateStep}
    />
  );
  if (step.lab === "reg") return (
    <RegressionRunLab
      step={step}
      settings={regressionSettings}
      onSettingsChange={onRegressionSettingsChange}
      history={regressionHistory}
      onHistoryChange={onRegressionHistoryChange}
    />
  );
  if (step.lab === "rep") return meta ? <ReportLab meta={meta} /> : null;
  return null;
}

export default function App() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  // 有效深链优先于服务端进度；应用内部切步只 replace 当前 URL，不污染浏览器历史。
  const explicitStep = useRef(stepFromUrl());
  const navigationTouched = useRef(false);
  const [current, setCurrent] = useState(() => explicitStep.current ?? 4);
  // 最远到达步:顶栏「学习进度」与大纲勾选按它显示,跳回前面复习不算进度倒退
  const [maxStep, setMaxStep] = useState(() => explicitStep.current ?? 1);
  const [progressReady, setProgressReady] = useState(false);
  const [regressionSettings, setRegressionSettings] = useState<RegressionSettings>(DEFAULT_REGRESSION_SETTINGS);
  // 最近运行对比提升到应用会话:离开步骤13–16(如去步骤12/17)再回来时不丢失。
  const [regressionHistory, setRegressionHistory] = useState<RegressionHistory>({});
  const [fatal, setFatal] = useState<string | null>(null);
  // 认证:localStorage 里的令牌先经 /api/auth/me 真实校验再放行
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  // 课堂公告:登录后拉一次,顶栏下方横幅展示(教学库不可用时静默隐藏)
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const highestAnnouncementId = useRef(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [bannerExpanded, setBannerExpanded] = useState(false);

  const navigateStep = useCallback((next: number) => {
    const step = Math.max(1, Math.min(17, next));
    navigationTouched.current = true;
    setCurrent(step);
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(step));
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

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
      setProgressReady(false);
      setRegressionHistory({});
    };
    window.addEventListener("gvcsim-auth-expired", onExpired);
    return () => window.removeEventListener("gvcsim-auth-expired", onExpired);
  }, []);

  useEffect(() => {
    if (!user) return;
    api.meta().then(setMeta, () => setMeta({ years: [], countries: [], sectors: [] }));
    if (user.role === "teacher") return; // 教师端不加载 17 步实验数据与公告横幅
    highestAnnouncementId.current = 0;
    setAnnouncements([]);
    setBannerDismissed(false);
    setBannerExpanded(false);
    api.steps().then(setStepsData, (e) => setFatal(String(e.message ?? e)));
  }, [user]);

  // 恢复本人上次进度；显式深链或用户已经主动导航时不覆盖当前选择。
  // 当前步推进时同步刷新最远步(服务端也按 GREATEST 维护,重新登录后恢复)。
  // 等进度恢复完成再开始跟随,避免换账号登录时旧会话的 current 污染新账号的最远步。
  useEffect(() => {
    if (progressReady) setMaxStep((m) => Math.max(m, current));
  }, [current, progressReady]);

  useEffect(() => {
    if (!user) {
      navigationTouched.current = false;
      setProgressReady(false);
      setMaxStep(1);
      return;
    }
    if (user.role !== "student") {
      setProgressReady(Boolean(user));
      return;
    }
    let live = true;
    setProgressReady(false);
    api.classroom.progress().then(
      (progress) => {
        if (!live) return;
        setMaxStep((m) => Math.max(m, progress.max_step ?? progress.current_step ?? 1));
        if (explicitStep.current == null && !navigationTouched.current) {
          navigateStep(progress.current_step ?? 4);
          navigationTouched.current = false;
        }
      },
      () => {
        if (live && explicitStep.current == null && !navigationTouched.current) {
          navigateStep(4);
          navigationTouched.current = false;
        }
      },
    ).finally(() => live && setProgressReady(true));
    return () => { live = false; };
  }, [user, navigateStep]);

  // 切步时顺带刷新公告；只有出现新的公告 ID 才让已关闭横幅重新出现。
  useEffect(() => {
    if (!user || user.role !== "student") return;
    let live = true;
    api.classroom.announcements().then((response) => {
      if (!live) return;
      const scan = scanAnnouncements(highestAnnouncementId.current, response.announcements);
      if (scan.hasNew) {
        setBannerDismissed(false);
        setBannerExpanded(false);
      }
      highestAnnouncementId.current = scan.highestSeen;
      setAnnouncements(response.announcements);
    }, () => {});
    return () => { live = false; };
  }, [user, current]);

  // 学生实验进度自动上报:停留在某步 1.5s 后写入教学库(失败静默,不打扰实验)
  useEffect(() => {
    if (!user || user.role !== "student" || !progressReady) return;
    const timer = window.setTimeout(() => {
      api.classroom.reportProgress(current).catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [user, current, progressReady]);

  if (!authChecked) return <div style={{ padding: 40 }} className="muted">加载中…</div>;
  if (!user)
    return (
      <LoginPage onLogin={(r) => {
        localStorage.setItem(AUTH_TOKEN_KEY, r.token);
        setUser(r.user);
        // 学生进交互式介绍;教师直达教师面板(不进入学生端)
        setShowIntro(r.user.role !== "teacher");
      }} />
    );

  // 教师端与学生端彻底分离:教师只有教师面板,没有 17 步实验入口
  if (user.role === "teacher")
    return (
      <div className="layout">
        <header className="topbar">
          <LogoMark size={30} />
          <div>
            <h1>供应链仿真系统</h1>
            <div className="sub">GVC SIMULATION LAB · 教师端</div>
          </div>
          <div className="topbar-user">
            <span className="muted">
              数据:OECD ICIO {meta?.years.length ? `${meta.years[0]}–${meta.years.at(-1)}` : "(未预计算)"}
            </span>
            <span className="role-chip" title={`教师账号 · ${user.username}`}>{user.name}</span>
            <button onClick={() => { localStorage.removeItem(AUTH_TOKEN_KEY); setUser(null); }}>退出</button>
          </div>
        </header>
        <TeacherDashboard user={user} />
        <ToastHost />
      </div>
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
  // 可视化步骤(viz)图表是主角:讲解卡默认折叠,给图表让出首屏纵向空间(可点开)
  const isViz = step.lab === "viz";

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
          {/* 学习进度按最远到达步显示,跳回前面复习不会“倒退”;当前位置见步骤标题栏 */}
          <span className="progress-pill" title={`最远到达第 ${maxStep} 步;当前在第 ${current} 步`}>
            学习进度 <b>{maxStep}</b><span>/17</span>
          </span>
          <span className="role-chip" title={`学生账号 · ${user.username}`}>{user.name}</span>
          <button onClick={() => setShowIntro(true)}>ⓘ 系统介绍</button>
          <button onClick={() => { localStorage.removeItem(AUTH_TOKEN_KEY); setUser(null); }}>退出</button>
        </div>
      </header>

      {announcements.length > 0 && !bannerDismissed && (
        <div className="announce-banner">
          <span className="announce-banner-ic">📢</span>
          <div className="announce-banner-body">
            <b>{announcements[0].title}</b>
            {announcements[0].body && bannerExpanded && <p>{announcements[0].body}</p>}
            {bannerExpanded && announcements.slice(1).map((a) => (
              <div key={a.id} className="announce-banner-more">
                <b>{a.title}</b>
                {a.body && <p>{a.body}</p>}
              </div>
            ))}
          </div>
          {(announcements.length > 1 || announcements[0].body) && (
            <button onClick={() => setBannerExpanded((v) => !v)}>
              {bannerExpanded ? "收起" : `展开${announcements.length > 1 ? `全部 ${announcements.length} 条` : ""}`}
            </button>
          )}
          <button onClick={() => setBannerDismissed(true)}>×</button>
        </div>
      )}

      {showIntro && (
        <IntroOverlay user={user} meta={meta} onDone={(gotoStep) => {
          setShowIntro(false);
          if (gotoStep) navigateStep(gotoStep);
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
              <div className="progress-bar" style={{ width: `${Math.max(6, (maxStep / 17) * 100)}%` }} />
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
                // ✓ 表示“到过的步骤”(≤最远步),跳回复习时后面的勾不会消失
                const state = s.n === current ? "cur" : s.n <= maxStep ? "past" : "future";
                return (
                  <button
                    type="button"
                    key={s.n}
                    className={`step-row${s.n === current ? " active" : ""}`}
                    aria-current={s.n === current ? "step" : undefined}
                    onClick={() => navigateStep(s.n)}
                  >
                    <span className={`step-badge ${state}`}>{state === "past" ? "✓" : s.n}</span>
                    <span className="step-row-title">{s.title}</span>
                    <span className="step-code">{String(s.n).padStart(2, "0")}</span>
                  </button>
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
              <button disabled={current <= 1} onClick={() => navigateStep(current - 1)}>← 上一步</button>
              <button className="primary" disabled={current >= 17} onClick={() => navigateStep(current + 1)}>下一步 →</button>
            </div>
          </div>

          <div className="content-row">
            <main className="content">
              <div className="content-inner">
                {!isReg && (
                  <details className="card accent concept-card" open={!isViz}>
                    <summary className="kicker">讲解</summary>
                    <p>{step.concept}</p>
                  </details>
                )}
                <Lab
                  step={step}
                  meta={meta}
                  regressionSettings={regressionSettings}
                  onRegressionSettingsChange={setRegressionSettings}
                  regressionHistory={regressionHistory}
                  onRegressionHistoryChange={setRegressionHistory}
                  onNavigateStep={navigateStep}
                />
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
                  <button type="button" className="rail-flow-row" onClick={() => navigateStep(prevStep.n)}>
                    <span className="rail-flow-k">↑ 上一步</span>
                    <span className="rail-flow-t">{prevStep.title}</span>
                  </button>
                )}
                <div className="rail-flow-row cur">
                  <span className="rail-flow-k">● 当前</span>
                  <span className="rail-flow-t">{step.title}</span>
                </div>
                {nextStep && (
                  <button type="button" className="rail-flow-row" onClick={() => navigateStep(nextStep.n)}>
                    <span className="rail-flow-k">↓ 下一步</span>
                    <span className="rail-flow-t">{nextStep.title}</span>
                  </button>
                )}
              </div>
            </aside>
          </div>

          <footer className="stepfooter">
            <div className="footer-loc">{stageName} · {step.title}</div>
            <div className="footer-dots">
              {steps.map((s) => (
                <button
                  type="button"
                  key={s.n}
                  onClick={() => navigateStep(s.n)}
                  aria-label={`前往步骤 ${s.n}：${s.title}`}
                  aria-current={s.n === current ? "step" : undefined}
                  className={`fdot${s.n === current ? " on" : s.n <= maxStep ? " past" : ""}`}
                />
              ))}
            </div>
            <div className="footer-next">{nextStep ? `下一步 · ${nextStep.title}` : "已到最后一步"}</div>
          </footer>
        </div>
      </div>
      <ToastHost />
    </div>
  );
}
