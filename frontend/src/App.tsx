import { useCallback, useEffect, useRef, useState } from "react";
import { beginAccountMetaLoad } from "./account-meta";
import { scanAnnouncements } from "./announcement-state";
import { AUTH_TOKEN_KEY, api } from "./api";
import { LogoMark } from "./brand";
import { IntroOverlay } from "./intro";
import { DbLab, IndicatorLab, QcLab, ReportLab, ShockLab, VizLab } from "./labs";
import {
  DEFAULT_REGRESSION_SETTINGS,
  RegressionRunLab,
  SIGNATURE_SETTINGS,
  asRegressionSettingsMap,
  type RegressionHistory,
  type RegressionSettings,
} from "./regression";
import { LoginPage } from "./login";
import { QuizPanel } from "./step-quiz";
import { TeacherDashboard } from "./teacher";
import { ToastHost } from "./toast";
import type { Announcement, AuthUser, Meta, Step, StepStateApi, StepsResponse } from "./types";
import { useSession, type SessionStatus } from "./use-session";

const ROMAN = ["", "一", "二", "三", "四", "五"];
const AUTH_EXPIRES_KEY = "gvcsim_token_expires_at";

function sessionExpiryLabel(expiresAt: number | null): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("zh-CN", { hour12: false });
}

function deadlineLabel(value: string | null | undefined): string {
  if (!value) return "教师设定的截止时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function stepFromUrl(): number | null {
  const n = Number(new URLSearchParams(window.location.search).get("step"));
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

function Lab({ step, meta, state, completionKey, sessionStatus, sessionUnsynced, sessionSyncing, sessionSyncError, onFlushSession, onSessionChanged, regressionSettings, onRegressionSettingsChange, regressionHistory, onRegressionHistoryChange, onNavigateStep }: {
  step: Step;
  meta: Meta | null;
  state: StepStateApi;
  completionKey: string;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  sessionSyncError: string | null;
  onFlushSession: () => Promise<void>;
  /** 服务端改写会话后（如生成报告写入第 16 步完成记录）重新装载完成度。 */
  onSessionChanged: () => void;
  regressionSettings: RegressionSettings;
  onRegressionSettingsChange: (settings: RegressionSettings) => void;
  regressionHistory: RegressionHistory;
  onRegressionHistoryChange: React.Dispatch<React.SetStateAction<RegressionHistory>>;
  onNavigateStep: (step: number) => void;
}) {
  if (step.lab === "db") return <DbLab state={state} />;
  if (step.lab === "qc") return meta ? <QcLab meta={meta} onNavigateStep={onNavigateStep} /> : null;
  if (step.lab === "shock") return meta ? <ShockLab meta={meta} step={step} state={state} /> : null;
  // key:同一实验台横跨多步时必须按步重挂载。否则 country 等步内状态会跨步带过去,
  // 自动保存的 effect 因依赖未变而不触发，新到的那一步拿不到“当前看的是谁”。
  if (step.lab === "ind") return meta ? <IndicatorLab key={step.n} meta={meta} step={step} state={state} /> : null;
  if (step.lab === "viz")
    return meta ? <VizLab key={step.n} meta={meta} step={step} state={state} /> : null;
  if (step.lab === "reg") return (
    <RegressionRunLab
      key={step.regression_outcome}
      step={step}
      state={state}
      settings={regressionSettings}
      onSettingsChange={onRegressionSettingsChange}
      history={regressionHistory}
      onHistoryChange={onRegressionHistoryChange}
    />
  );
  if (step.lab === "rep") return (
    <ReportLab
      key={`${meta?.assignment_id ?? "none"}:${meta?.attempt_id ?? "none"}`}
      completionKey={completionKey}
      sessionStatus={sessionStatus}
      sessionUnsynced={sessionUnsynced}
      sessionSyncing={sessionSyncing}
      sessionSyncError={sessionSyncError}
      onFlushSession={onFlushSession}
      onNavigateStep={onNavigateStep}
      onGenerated={onSessionChanged}
    />
  );
  return null;
}

export default function App() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  // 有效深链优先于服务端进度；应用内部切步只 replace 当前 URL，不污染浏览器历史。
  const explicitStep = useRef(stepFromUrl());
  const navigationTouched = useRef(false);
  // 新会话从第 1 步开始:课程顺序是数据接入 → 指标 → 可视化 → 回归,
  // 从中途开始会让学生在没读过数据、mock 边界和质检的情况下直接看指标分解。
  const [current, setCurrent] = useState(() => explicitStep.current ?? 1);
  // 最远到达步:仅表示“到过哪里”这一位置,不表示做过或学会了什么。
  // 深链可直接把它推到任意步(?step=12 即为 12),因此它连“已浏览步数”都不是。
  const [maxStep, setMaxStep] = useState(() => explicitStep.current ?? 1);
  const [progressReady, setProgressReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  // 认证:localStorage 里的令牌先经 /api/auth/me 真实校验再放行
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authExpiresAt, setAuthExpiresAt] = useState<number | null>(() => {
    const value = Number(localStorage.getItem(AUTH_EXPIRES_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const [showIntro, setShowIntro] = useState(false);
  // 课堂公告:登录后拉一次,顶栏下方横幅展示(教学库不可用时静默隐藏)
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const highestAnnouncementId = useRef(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [bannerExpanded, setBannerExpanded] = useState(false);
  const [resettingAttempt, setResettingAttempt] = useState(false);
  const [resetAttemptError, setResetAttemptError] = useState<string | null>(null);
  const [deadlineNow, setDeadlineNow] = useState(() => Date.now());

  // 实验会话:回归设定与运行记录从此活在会话里(local-first + PostgreSQL),
  // 刷新或重新登录都能恢复,不再随组件内存一起消失。
  const session = useSession(
    user?.role === "student" ? { username: user.username, accountId: user.account_id } : null,
    meta?.manifest_id ? {
      manifestId: meta.manifest_id,
      courseRunId: meta.course_run_id,
      assignmentId: meta.assignment_id,
      attemptId: meta.attempt_id,
    } : null,
  );
  const assignmentDueAt = meta?.due_at ?? session.dueAt;
  const assignmentDueTime = assignmentDueAt ? new Date(assignmentDueAt).getTime() : Number.NaN;
  const assignmentClosed = Boolean(meta?.assignment_closed || session.assignmentClosed)
    || (Number.isFinite(assignmentDueTime) && assignmentDueTime <= deadlineNow);
  useEffect(() => {
    if (!Number.isFinite(assignmentDueTime) || assignmentDueTime <= Date.now()) return;
    const delay = Math.min(2_147_000_000, Math.max(0, assignmentDueTime - Date.now() + 250));
    const timer = window.setTimeout(() => setDeadlineNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [assignmentDueTime, deadlineNow]);
  const exportRecovery = useCallback(() => {
    if (!session.recovery.length) return;
    const exported = {
      exported_at: new Date().toISOString(),
      account_id: user?.account_id ?? null,
      username: user?.username ?? null,
      warning: "这些记录来自旧作用域/旧数据版本，仅供留档，不得合并到当前 attempt。",
      records: session.recovery,
    };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `gvcsim-recovery-${String(user?.username ?? "student").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }, [session.recovery, user?.account_id, user?.username]);
  const resetAttempt = useCallback(async () => {
    const confirmed = window.confirm(
      "重新开始会归档当前 attempt，并由服务端创建一个全新的 attempt。旧记录不会合并到新作业；如需留档，请先点击“导出隔离记录”。确定继续吗？",
    );
    if (!confirmed) return;
    setResettingAttempt(true);
    setResetAttemptError(null);
    try {
      await session.reset();
    } catch (cause) {
      setResetAttemptError(String((cause as Error).message ?? cause));
      setResettingAttempt(false);
    }
  }, [session.reset]);
  // 回归设定按 outcome 存(与 regression_history 一致):每步首次进入落在其招牌默认
  // (SIGNATURE_SETTINGS),学生的修改按 outcome 分别保留、互不覆盖。
  const currentOutcome = stepsData?.steps.find((s) => s.n === current)?.regression_outcome;
  const regressionSettings =
    (currentOutcome && asRegressionSettingsMap(session.getShared("regression_settings"))[currentOutcome]) ||
    (currentOutcome ? SIGNATURE_SETTINGS[currentOutcome] : DEFAULT_REGRESSION_SETTINGS);
  const regressionHistory = session.getShared<RegressionHistory>("regression_history") ?? {};
  const setRegressionSettings = useCallback(
    (next: RegressionSettings) => {
      if (!currentOutcome) return;
      session.updateShared("regression_settings", (current) => ({
        ...asRegressionSettingsMap(current),
        [currentOutcome]: next,
      }));
    },
    [session, currentOutcome],
  );
  const setRegressionHistory = useCallback(
    (update: React.SetStateAction<RegressionHistory>) => {
      session.updateShared<RegressionHistory>("regression_history", (current) => {
        const base = current ?? {};
        return typeof update === "function" ? update(base) : update;
      });
    },
    [session],
  );
  const completedSteps = new Set(session.completion?.completed ?? []);
  const completionKey = session.completion?.completed.join(",") ?? "unavailable";

  // 当前步的状态读写口。实验快照与答题结果分次产生，save 必须逐字段合并。
  const currentCompletion = session.completion?.steps.find((item) => item.step === current);
  const stepState: StepStateApi = {
    data: session.getStep(current),
    save: (patch) => session.patchStep(current, patch),
    complete: currentCompletion?.complete ?? false,
    syncing: session.syncing,
    syncError: session.syncError,
    syncNow: () => { void session.syncNow().catch(() => {}); },
  };

  // 退出登录:只清认证与界面状态。刻意**不**清实验会话——
  // 学生重新登录后必须能拿回自己的实验,这正是会话存在的意义。
  const logout = useCallback(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token) void api.logout(token).catch(() => {});
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_EXPIRES_KEY);
    setAuthExpiresAt(null);
    setUser(null);
    setStepsData(null);
    setMeta(null);
    setFatal(null);
    setShowIntro(false);
    setProgressReady(false);
    setAnnouncements([]);
    highestAnnouncementId.current = 0;
    setBannerDismissed(false);
    setBannerExpanded(false);
    explicitStep.current = null;
    navigationTouched.current = false;
    setCurrent(1);
    setMaxStep(1);
    const url = new URL(window.location.href);
    url.searchParams.delete("step");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const navigateStep = useCallback((next: number) => {
    const available = stepsData?.steps ?? [];
    const last = available.at(-1)?.n ?? 16;
    const bounded = Math.max(1, Math.min(last, next));
    const target = available.length && !available.some((item) => item.n === bounded) ? (available[0]?.n ?? 1) : bounded;
    navigationTouched.current = true;
    setCurrent(target);
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(target));
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [stepsData]);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) { setAuthChecked(true); return; }
    api.me(token).then(
      (u) => { setUser(u); setAuthChecked(true); },
      () => {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(AUTH_EXPIRES_KEY);
        setAuthExpiresAt(null);
        setAuthChecked(true);
      },
    );
  }, []);

  useEffect(() => {
    window.addEventListener("gvcsim-auth-expired", logout);
    return () => window.removeEventListener("gvcsim-auth-expired", logout);
  }, [logout]);

  const accountId = user?.account_id ?? null;
  const accountRole = user?.role ?? null;
  useEffect(() => {
    if (accountId == null || accountRole == null) return;
    let live = true;
    // 新账号解析完成前不沿用上一账号的 assignment/attempt。
    setMeta(null);
    const cancelMetaLoad = beginAccountMetaLoad(() => api.meta(), setMeta);
    if (accountRole === "teacher") {
      return () => {
        live = false;
        cancelMetaLoad();
      };
    }
    // 教师端不加载 16 步实验数据与公告横幅。
    highestAnnouncementId.current = 0;
    setAnnouncements([]);
    setBannerDismissed(false);
    setBannerExpanded(false);
    api.steps().then(
      (value) => { if (live) setStepsData(value); },
      (error) => { if (live) setFatal(String(error.message ?? error)); },
    );
    return () => {
      live = false;
      cancelMetaLoad();
    };
  }, [accountId, accountRole]);

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
          navigateStep(progress.current_step ?? 1);
          navigationTouched.current = false;
        }
      },
      () => {
        // 读不到上次位置就从头开始,不要假设学生已经过了前几步。
        if (live && explicitStep.current == null && !navigationTouched.current) {
          navigateStep(1);
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
    if (!user || user.role !== "student" || !progressReady || assignmentClosed) return;
    const timer = window.setTimeout(() => {
      api.classroom.reportProgress(current).catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [user, current, progressReady, assignmentClosed]);

  if (!authChecked) return <div style={{ padding: 40 }} className="muted">加载中…</div>;
  if (!user)
    return (
      <LoginPage onLogin={(r) => {
        localStorage.setItem(AUTH_TOKEN_KEY, r.token);
        localStorage.setItem(AUTH_EXPIRES_KEY, String(r.expires_at));
        setAuthExpiresAt(r.expires_at);
        setUser(r.user);
        // 学生进交互式介绍;教师直达教师面板(不进入学生端)
        setShowIntro(r.user.role !== "teacher");
      }} />
    );

  // 教师端与学生端彻底分离:教师只有教师面板,没有 16 步实验入口
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
            {sessionExpiryLabel(authExpiresAt) && <span className="muted">会话至 {sessionExpiryLabel(authExpiresAt)}</span>}
            <span className="role-chip" title={`教师账号 · ${user.username}`}>{user.name}</span>
            <button onClick={logout}>退出</button>
          </div>
        </header>
        <TeacherDashboard user={user} />
        {/* 教师端 ToastHost:与下方学生端的实例互斥(此处提前 return),任一时刻只挂载一个;
            切勿在两个分支之外再挂一份,否则同一 toast 会重复弹出 */}
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
  const totalSteps = steps.length;
  const stepIndex = steps.findIndex((item) => item.n === current);
  if (stepIndex < 0) return <div style={{ padding: 40 }} className="error-box">步骤不存在，请从课程大纲重新选择。</div>;
  const step = steps[stepIndex];
  const stages = [...new Set(steps.map((s) => s.stage))];
  const stageName = stepsData.stages[String(step.stage)];
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  // 回归工作台自带完整渐进教学结构，主区跳过通用讲解卡避免重复。
  const isReg = step.lab === "reg";
  // 可视化步骤(viz)图表是主角:讲解卡默认折叠,给图表让出首屏纵向空间(可点开)
  const isViz = step.lab === "viz";
  const assignmentScopeMissing = !meta
    || meta.course_run_id == null
    || meta.assignment_id == null
    || meta.attempt_id == null;
  const assignmentLocked = assignmentScopeMissing
    || session.stale
    || assignmentClosed
    || Boolean(meta?.assignment_unavailable || meta?.manifest_mismatch);

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
          {/* 完成度由服务端按答题结果/报告生成判定，位置不冒充完成度。
              位置信息退到 title 里:到过第几步不是成绩。 */}
          {session.completion ? (
            <span
              className="progress-pill"
              title={`已完成 ${session.completion.completed_count} 步；最远到过第 ${maxStep} 步（到过不等于完成）`}
            >
              已完成 <b>{session.completion.completed_count}</b><span>/{totalSteps}</span>
            </span>
          ) : (
            // 判定只在服务端;拿不到就说明拿不到,不用位置冒充完成度。
            <span className="progress-pill" title={`最远到过第 ${maxStep} 步`}>
              最远到第 <b>{Math.min(maxStep, totalSteps)}</b> 步
            </span>
          )}
            <span className="role-chip" title={`学生账号 · ${user.username}`}>{user.name}</span>
            {sessionExpiryLabel(authExpiresAt) && <span className="muted" title="服务端签发的 expires_at">会话至 {sessionExpiryLabel(authExpiresAt)}</span>}
          <button onClick={() => setShowIntro(true)}>ⓘ 系统介绍</button>
          <button onClick={logout}>退出</button>
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
              <span className="sidebar-steps">{totalSteps} STEPS</span>
            </div>
            {/* 有服务端完成度时画真实完成度;拿不到就退回位置条并如实说明。 */}
            {session.completion ? (
              <div
                className="progress-track"
                role="img"
                aria-label={`已完成 ${session.completion.completed_count} 步,共 ${totalSteps} 步`}
              >
                <div
                  className="progress-bar done"
                  style={{ width: `${Math.max(2, (session.completion.completed_count / totalSteps) * 100)}%` }}
                />
              </div>
            ) : (
              <div
                className="progress-track"
                role="img"
                aria-label={`最远到过第 ${Math.min(maxStep, totalSteps)} 步,共 ${totalSteps} 步;这是浏览位置,不代表已完成`}
              >
                <div className="progress-bar" style={{ width: `${Math.max(6, (Math.min(maxStep, totalSteps) / totalSteps) * 100)}%` }} />
              </div>
            )}
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
                // ✓ 只给服务端判定完成的步骤；到过仍只是一种导航状态。
                // past 仅表示“到过”,是导航信息,一律显示步号——到过不是做过。
                const done = completedSteps.has(s.n);
                const state = done ? "done" : s.n === current ? "cur" : s.n <= maxStep ? "past" : "future";
                return (
                  <button
                    type="button"
                    key={s.n}
                    className={`step-row${s.n === current ? " active" : ""}`}
                    aria-current={s.n === current ? "step" : undefined}
                    onClick={() => navigateStep(s.n)}
                    title={done ? `第 ${s.n} 步已完成` : undefined}
                  >
                    <span className={`step-badge ${state}`}>{done ? "✓" : s.n}</span>
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
          {session.syncError && !assignmentClosed && (
            <div className="error-box persistent-qc-warning" role="alert">
              <b>实验记录尚未同步到服务器。</b>
              <p>{session.syncError} 本地记录仍在，可以直接重试。</p>
              <button
                type="button"
                className="secondary"
                disabled={session.syncing}
                onClick={() => { void session.syncNow().catch(() => {}); }}
              >
                {session.syncing ? "正在重试…" : "重试保存"}
              </button>
            </div>
          )}
          {meta?.manifest_mismatch && (
            <div className="warnbox persistent-qc-warning" role="alert">
              当前数据 manifest 与这份作业冻结的版本不一致。为避免混用数据，答题、实验记录、报告与提交将保持锁定；请联系教师切换作业版本。
            </div>
          )}
          {assignmentClosed && (
            <div className="warnbox persistent-qc-warning assignment-closed-warning" role="alert">
              <b>作业已于 {deadlineLabel(assignmentDueAt)} 截止，现在为只读状态。</b>
              <p>你仍可浏览既有步骤、答题结果与服务端完成度，但不能继续保存实验状态、答题、生成/提交报告、重置或新建 attempt。既有记录和审计历史不会被删除。</p>
            </div>
          )}
          {!assignmentClosed && (meta?.assignment_unavailable || assignmentScopeMissing) && (
            <div className="warnbox persistent-qc-warning" role="alert">
              无法确认当前课程、作业与 attempt 作用域；实验输入与提交已锁定，本地缓存也已停用。
              请刷新重试；仍未恢复时联系教师检查选课、作业发布和数据库状态。
            </div>
          )}
          {session.stale && !assignmentClosed && (
            <div className="warnbox legacy-session-warning" role="status">
              <div>
                发现旧课程、旧数据版本或用户名作用域的记录。它已被隔离为只读旧记录，
                不会合并、不会自动回推，也不会计入本次作业完成度。
              </div>
              <div className="session-actions" style={{ marginTop: 10 }}>
                <button type="button" className="secondary" disabled={!session.recovery.length || resettingAttempt} onClick={exportRecovery}>
                  导出隔离记录
                </button>
                <button type="button" className="primary" disabled={resettingAttempt} onClick={() => void resetAttempt()}>
                  {resettingAttempt ? "正在归档并新建…" : "归档旧 attempt 并重新开始"}
                </button>
              </div>
              <p className="muted">重新开始是显式操作：旧 attempt 会保留为审计记录，新 attempt 从空白状态开始。</p>
              {resetAttemptError && <div className="error-box">重新开始失败：{resetAttemptError}</div>}
            </div>
          )}
          <div className="step-header-bar">
            <div className="big-num">{String(step.n).padStart(2, "0")}</div>
            <div className="step-header-mid">
              <div className="step-header-meta">
                <span className="stage-chip">{stageName}</span>
                <span className="step-count">STEP {step.n} / {totalSteps}</span>
              </div>
              <h2>{step.title}</h2>
            </div>
            <div className="nav-btns">
              <button disabled={!prevStep} onClick={() => prevStep && navigateStep(prevStep.n)}>← 上一步</button>
              <button className="primary" disabled={!nextStep} onClick={() => nextStep && navigateStep(nextStep.n)}>下一步 →</button>
            </div>
          </div>

          <div className="content-row">
            <main className="content">
              <div className="content-inner">
                {/* 已把 concept 并入页内 StepIntro(常驻)的步骤,这里不再重复渲染讲解卡:
                    可视化(isViz)、指标计算(ind)、政策冲击接入(shock);回归自带渐进教学,也跳过。 */}
                {!isReg && !isViz && step.lab !== "ind" && step.lab !== "shock" && (
                  <details className="card accent concept-card" open>
                    <summary className="kicker">讲解</summary>
                    <p>{step.concept}</p>
                  </details>
                )}
                {assignmentClosed ? (
                  <div className="read-only-lab" inert aria-label="已截止作业的只读实验记录">
                    <Lab
                      step={step}
                      meta={meta}
                      state={stepState}
                      completionKey={completionKey}
                      sessionStatus={session.status}
                      sessionUnsynced={session.unsynced}
                      sessionSyncing={session.syncing}
                      sessionSyncError={session.syncError}
                      onFlushSession={session.syncNow}
                      onSessionChanged={session.reload}
                      regressionSettings={regressionSettings}
                      onRegressionSettingsChange={setRegressionSettings}
                      regressionHistory={regressionHistory}
                      onRegressionHistoryChange={setRegressionHistory}
                      onNavigateStep={navigateStep}
                    />
                    <QuizPanel key={step.n} step={step} state={stepState} />
                  </div>
                ) : assignmentLocked ? (
                  <div className="error-box assignment-lock" role="alert">
                    <h3>实验台已锁定</h3>
                    <p>
                      {meta?.manifest_mismatch
                        ? "当前产物与作业冻结的数据版本不一致，不能保存实验状态、答题或生成报告。"
                        : session.stale
                          ? "检测到旧课程、旧数据版本或未验证 attempt 的记录。请先在上方导出留档，并显式归档旧 attempt 后重新开始。"
                        : "当前账号没有可验证的课程运行、作业或 attempt 上下文；此时填写内容不会被可靠保存，因此表单没有开放。"}
                    </p>
                    <p>刷新后仍未恢复，请联系教师确认作业是否已发布并将你加入对应课程运行。</p>
                  </div>
                ) : (
                  <>
                    <Lab
                      step={step}
                      meta={meta}
                      state={stepState}
                      completionKey={completionKey}
                      sessionStatus={session.status}
                      sessionUnsynced={session.unsynced}
                      sessionSyncing={session.syncing}
                      sessionSyncError={session.syncError}
                      onFlushSession={session.syncNow}
                      onSessionChanged={session.reload}
                      regressionSettings={regressionSettings}
                      onRegressionSettingsChange={setRegressionSettings}
                      regressionHistory={regressionHistory}
                      onRegressionHistoryChange={setRegressionHistory}
                      onNavigateStep={navigateStep}
                    />
                    <QuizPanel key={step.n} step={step} state={stepState} />
                  </>
                )}
              </div>
            </main>

            <aside className="rightrail">
              <div className="rail-head"><span className="rail-head-ic">📌</span>本步速览</div>
              <div className="rail-stage">
                <div className="rail-stage-loc">阶段{ROMAN[step.stage]} · {stageName}</div>
                <div className="rail-stage-num"><b>{String(step.n).padStart(2, "0")}</b><span>/ {totalSteps} 步</span></div>
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
                  className={`fdot${s.n === current ? " on" : completedSteps.has(s.n) ? " done" : s.n <= maxStep ? " past" : ""}`}
                />
              ))}
            </div>
            <div className="footer-next">{nextStep ? `下一步 · ${nextStep.title}` : "已到最后一步"}</div>
          </footer>
        </div>
      </div>
      {/* 学生端 ToastHost:与上方教师端实例互斥,任一时刻只挂载一个(见教师分支处说明) */}
      <ToastHost />
    </div>
  );
}
