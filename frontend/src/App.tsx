import { useCallback, useEffect, useRef, useState } from "react";
import { beginAccountMetaLoad } from "./account-meta";
import { AccountPasswordModal } from "./account-password";
import {
  AnnouncementBanner,
  AppBootSkeleton,
  CourseSidebar,
  StepFooter,
  StepHeader,
  StepRail,
  StudentTopbar,
  TeacherWorkspace,
} from "./app-shell";
import { scanAnnouncements } from "./announcement-state";
import { AUTH_TOKEN_KEY, api } from "./api";
import { LabRouter } from "./lab-router";
import { IntroOverlay } from "./intro";
import {
  DEFAULT_REGRESSION_SETTINGS,
  SIGNATURE_SETTINGS,
  asRegressionSettingsMap,
  type RegressionHistory,
  type RegressionSettings,
} from "./regression";
import { LoginPage } from "./login";
import { resetStepScroller } from "./step-navigation";
import { QuizPanel } from "./step-quiz";
import { ToastHost } from "./toast";
import type {
  Announcement,
  AuthUser,
  Meta,
  StepsResponse,
  StepStateApi,
} from "./types";
import { useSession } from "./use-session";

const AUTH_EXPIRES_KEY = "gvcsim_token_expires_at";

function stepFromUrl(): number | null {
  const n = Number(new URLSearchParams(window.location.search).get("step"));
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

export default function App() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaReady, setMetaReady] = useState(false);
  const [announcementsReady, setAnnouncementsReady] = useState(false);
  // 有效深链优先于服务端进度；应用内部切步只 replace 当前 URL，不污染浏览器历史。
  const explicitStep = useRef(stepFromUrl());
  const navigationTouched = useRef(false);
  // 新会话从第 1 步开始:课程顺序是数据接入 → 指标 → 可视化 → 回归,
  // 从中途开始会让学生在没读过数据、mock 边界和质检的情况下直接看指标分解。
  const [current, setCurrent] = useState(() => explicitStep.current ?? 1);
  const contentRef = useRef<HTMLElement>(null);
  // 最远到达步:仅表示“到过哪里”这一位置,不表示做过或学会了什么。
  // 深链可直接把它推到任意步(?step=12 即为 12),因此它连“已浏览步数”都不是。
  const [maxStep, setMaxStep] = useState(() => explicitStep.current ?? 1);
  const [progressReady, setProgressReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  // 认证:localStorage 里的令牌先经 /api/auth/me 真实校验再放行
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(() => !localStorage.getItem(AUTH_TOKEN_KEY));
  const [authExpiresAt, setAuthExpiresAt] = useState<number | null>(() => {
    const value = Number(localStorage.getItem(AUTH_EXPIRES_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  const introTriggerRef = useRef<HTMLButtonElement>(null);
  // 课堂公告:登录后拉一次,顶栏下方横幅展示(教学库不可用时静默隐藏)
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const highestAnnouncementId = useRef(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [bannerExpanded, setBannerExpanded] = useState(false);
  const [resettingWorkspace, setResettingWorkspace] = useState(false);
  const [resetWorkspaceError, setResetWorkspaceError] = useState<string | null>(null);

  // 实验会话:回归设定与运行记录从此活在会话里(local-first + PostgreSQL),
  // 刷新或重新登录都能恢复,不再随组件内存一起消失。
  const session = useSession(
    user?.role === "student" ? { username: user.username, accountId: user.account_id } : null,
    meta?.manifest_id ? { manifestId: meta.manifest_id } : null,
  );
  const resetWorkspace = useCallback(async () => {
    const confirmation = window.prompt(
      "此操作会永久删除当前数据版本下的实验进度、证据、报告、提交和评分。请输入“清空当前实验”继续：",
    );
    if (confirmation !== "清空当前实验") return;
    setResettingWorkspace(true);
    setResetWorkspaceError(null);
    try {
      await session.reset();
    } catch (cause) {
      setResetWorkspaceError(String((cause as Error).message ?? cause));
      setResettingWorkspace(false);
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
    setMetaReady(false);
    setAnnouncementsReady(false);
    setFatal(null);
    setShowIntro(false);
    setShowPasswordChange(false);
    setProgressReady(false);
    setAnnouncements([]);
    setResettingWorkspace(false);
    setResetWorkspaceError(null);
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

  const passwordChanged = useCallback(() => {
    setAuthNotice("密码已修改，所有旧会话均已撤销。请使用新密码重新登录。");
    setShowPasswordChange(false);
    logout();
  }, [logout]);

  const navigateStep = useCallback((next: number) => {
    const available = stepsData?.steps ?? [];
    const last = available.at(-1)?.n ?? 16;
    const bounded = Math.max(1, Math.min(last, next));
    const target = available.length && !available.some((item) => item.n === bounded) ? (available[0]?.n ?? 1) : bounded;
    // .content 是跨步骤复用的内部滚动容器。先归零再切内容，避免新步骤
    // 继承上一页的纵向/横向位置而从答题区或表格右端开始。
    resetStepScroller(contentRef.current);
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
    // 新账号解析完成前不沿用上一账号的数据版本。
    setMeta(null);
    setMetaReady(false);
    const cancelMetaLoad = beginAccountMetaLoad(() => api.meta(), (value) => {
      if (!live) return;
      setMeta(value);
      setMetaReady(true);
    });
    if (accountRole === "teacher") {
      return () => {
        live = false;
        cancelMetaLoad();
      };
    }
    // 教师端不加载 16 步实验数据与公告横幅。
    highestAnnouncementId.current = 0;
    setAnnouncements([]);
    setAnnouncementsReady(false);
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
      setAnnouncementsReady(true);
    }, () => {
      if (live) setAnnouncementsReady(true);
    });
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

  if (!authChecked) return <AppBootSkeleton />;
  if (!user)
    return (
      <LoginPage notice={authNotice} onLogin={(r) => {
        localStorage.setItem(AUTH_TOKEN_KEY, r.token);
        localStorage.setItem(AUTH_EXPIRES_KEY, String(r.expires_at));
        setAuthExpiresAt(r.expires_at);
        setAuthNotice(null);
        setUser(r.user);
        // 学生进交互式介绍;教师直达教师面板(不进入学生端)
        setShowIntro(r.user.role !== "teacher");
      }} />
    );

  // 教师端与学生端彻底分离:教师只有教师面板,没有 16 步实验入口
  if (user.role === "teacher") {
    return (
      <TeacherWorkspace
        user={user}
        meta={meta}
        authExpiresAt={authExpiresAt}
        showPasswordChange={showPasswordChange}
        onRequestPasswordChange={() => setShowPasswordChange(true)}
        onClosePasswordChange={() => setShowPasswordChange(false)}
        onPasswordChanged={passwordChanged}
        onLogout={logout}
      />
    );
  }

  if (fatal)
    return (
      <div style={{ padding: 40 }}>
        <div className="error-box">
          无法连接后端 API:{fatal}
          <br />请先启动服务:<code>uv run gvcsim serve</code>
        </div>
      </div>
    );
  if (
    !stepsData
    || !metaReady
    || !announcementsReady
    || !progressReady
    || session.status === "loading"
  ) {
    return <AppBootSkeleton />;
  }

  const steps = stepsData.steps;
  const totalSteps = steps.length;
  const stepIndex = steps.findIndex((item) => item.n === current);
  if (stepIndex < 0) return <div style={{ padding: 40 }} className="error-box">步骤不存在，请从课程大纲重新选择。</div>;
  const step = steps[stepIndex];
  const stageName = stepsData.stages[String(step.stage)];
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  // 回归工作台自带完整渐进教学结构，主区跳过通用讲解卡避免重复。
  const isReg = step.lab === "reg";
  // 可视化步骤(viz)图表是主角:讲解卡默认折叠,给图表让出首屏纵向空间(可点开)
  const isViz = step.lab === "viz";
  return (
    <>
    <div className="layout" inert={showIntro ? true : undefined}>
      <StudentTopbar
        user={user}
        meta={meta}
        authExpiresAt={authExpiresAt}
        resettingWorkspace={resettingWorkspace}
        completion={session.completion}
        maxStep={maxStep}
        totalSteps={totalSteps}
        introTriggerRef={introTriggerRef}
        onResetWorkspace={() => { void resetWorkspace(); }}
        onShowIntro={() => setShowIntro(true)}
        onRequestPasswordChange={() => setShowPasswordChange(true)}
        onLogout={logout}
      />

      {resetWorkspaceError && (
        <div className="error-box workspace-reset-error" role="alert">清空实验失败：{resetWorkspaceError}</div>
      )}

      {!bannerDismissed && (
        <AnnouncementBanner
          announcements={announcements}
          expanded={bannerExpanded}
          onToggle={() => setBannerExpanded((value) => !value)}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}

      <div className="main">
        <CourseSidebar
          stepsData={stepsData}
          current={current}
          maxStep={maxStep}
          completion={session.completion}
          onNavigate={navigateStep}
        />

        <div className="workarea">
          {session.syncError && (
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
          <StepHeader
            step={step}
            previous={prevStep}
            next={nextStep}
            stageName={stageName}
            totalSteps={totalSteps}
            onNavigate={navigateStep}
          />

          <div className="content-row">
            <main ref={contentRef} className="content">
              <div className="content-inner">
                {/* 已把 concept 并入页内 StepIntro(常驻)的步骤,这里不再重复渲染讲解卡:
                    可视化(isViz)、指标计算(ind)、政策冲击接入(shock);回归自带渐进教学,也跳过。 */}
                {!isReg && !isViz && step.lab !== "ind" && step.lab !== "shock" && (
                  <details className="card accent concept-card" open>
                    <summary className="kicker">讲解</summary>
                    <p>{step.concept}</p>
                  </details>
                )}
                <>
                    <LabRouter
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
              </div>
            </main>

            <StepRail
              step={step}
              previous={prevStep}
              next={nextStep}
              stageName={stageName}
              totalSteps={totalSteps}
              onNavigate={navigateStep}
            />
          </div>

          <StepFooter
            steps={steps}
            step={step}
            next={nextStep}
            stageName={stageName}
            current={current}
            maxStep={maxStep}
            completedSteps={completedSteps}
            onNavigate={navigateStep}
          />
        </div>
      </div>
      {/* 学生端 ToastHost:与上方教师端实例互斥,任一时刻只挂载一个(见教师分支处说明) */}
      <ToastHost />
    </div>
    {showIntro && (
      <IntroOverlay
        user={user}
        meta={meta}
        returnFocusRef={introTriggerRef}
        onDone={(gotoStep) => {
          setShowIntro(false);
          if (gotoStep) navigateStep(gotoStep);
        }}
      />
    )}
    {showPasswordChange && (
      <AccountPasswordModal onClose={() => setShowPasswordChange(false)} onChanged={passwordChanged} />
    )}
    </>
  );
}
