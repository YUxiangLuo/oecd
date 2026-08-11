import { useCallback, useEffect, useRef, useState } from "react";
import { beginAccountMetaLoad } from "./account-meta";
import {
  clearAuthentication,
  readAuthExpiry,
  stepFromSearch,
  storeAuthentication,
  urlWithoutStep,
  urlWithStep,
} from "./app-state";
import { AppBootSkeleton, TeacherWorkspace } from "./app-shell";
import { scanAnnouncements } from "./announcement-state";
import {
  EMPTY_SCOPED_REGRESSION_HISTORY,
  historyForAccount,
  updateHistoryForAccount,
} from "./account-regression-history";
import { AUTH_TOKEN_KEY, api } from "./api";
import {
  DEFAULT_REGRESSION_SETTINGS,
  SIGNATURE_SETTINGS,
  asRegressionSettingsMap,
  type RegressionHistory,
  type RegressionSettings,
} from "./regression";
import { LoginPage } from "./login";
import { resetStepScroller } from "./step-navigation";
import { StudentWorkspace } from "./student-workspace";
import type {
  Announcement,
  AuthUser,
  Meta,
  StepsResponse,
  StepStateApi,
} from "./types";
import { useSession } from "./use-session";

export default function App() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaReady, setMetaReady] = useState(false);
  const [announcementsReady, setAnnouncementsReady] = useState(false);
  // 有效深链优先于服务端进度；应用内部切步只 replace 当前 URL，不污染浏览器历史。
  const explicitStep = useRef(stepFromSearch(window.location.search));
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
  const [authExpiresAt, setAuthExpiresAt] = useState<number | null>(() => readAuthExpiry(localStorage));
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

  const session = useSession(
    user?.role === "student" ? { username: user.username, accountId: user.account_id } : null,
  );
  const resetWorkspace = useCallback(async () => {
    const confirmation = window.prompt(
      "此操作会删除你的实验进度、报告、提交和评分。请输入“清空当前实验”继续：",
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
  // 回归设定按 outcome 存；页面内运行历史只放在内存中。
  // (SIGNATURE_SETTINGS),学生的修改按 outcome 分别保留、互不覆盖。
  const currentOutcome = stepsData?.steps.find((s) => s.n === current)?.regression_outcome;
  const regressionSettings =
    (currentOutcome && asRegressionSettingsMap(session.getShared("regression_settings"))[currentOutcome]) ||
    (currentOutcome ? SIGNATURE_SETTINGS[currentOutcome] : DEFAULT_REGRESSION_SETTINGS);
  const regressionAccountId = user?.role === "student" && user.account_id != null
    ? String(user.account_id)
    : null;
  const [scopedRegressionHistory, setScopedRegressionHistory] = useState(EMPTY_SCOPED_REGRESSION_HISTORY);
  const regressionHistory = historyForAccount(scopedRegressionHistory, regressionAccountId);
  const setRegressionHistory = useCallback<React.Dispatch<React.SetStateAction<RegressionHistory>>>((update) => {
    if (regressionAccountId === null) return;
    setScopedRegressionHistory((currentHistory) => (
      updateHistoryForAccount(currentHistory, regressionAccountId, update)
    ));
  }, [regressionAccountId]);
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
    clearAuthentication(localStorage);
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
    setScopedRegressionHistory(EMPTY_SCOPED_REGRESSION_HISTORY);
    setResettingWorkspace(false);
    setResetWorkspaceError(null);
    highestAnnouncementId.current = 0;
    setBannerDismissed(false);
    setBannerExpanded(false);
    explicitStep.current = null;
    navigationTouched.current = false;
    setCurrent(1);
    setMaxStep(1);
    window.history.replaceState(null, "", urlWithoutStep(window.location.href));
  }, []);

  const passwordChanged = useCallback(() => {
    setAuthNotice("密码已修改。请使用新密码重新登录。");
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
    window.history.replaceState(null, "", urlWithStep(window.location.href, target));
  }, [stepsData]);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) { setAuthChecked(true); return; }
    api.me(token).then(
      (u) => { setUser(u); setAuthChecked(true); },
      () => {
        clearAuthentication(localStorage);
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
        storeAuthentication(localStorage, r.token, r.expires_at);
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

  return (
    <StudentWorkspace
      user={user}
      meta={meta}
      stepsData={stepsData}
      current={current}
      maxStep={maxStep}
      session={session}
      stepState={stepState}
      completionKey={completionKey}
      completedSteps={completedSteps}
      regressionSettings={regressionSettings}
      onRegressionSettingsChange={setRegressionSettings}
      regressionHistory={regressionHistory}
      onRegressionHistoryChange={setRegressionHistory}
      announcements={announcements}
      bannerDismissed={bannerDismissed}
      bannerExpanded={bannerExpanded}
      resettingWorkspace={resettingWorkspace}
      resetWorkspaceError={resetWorkspaceError}
      authExpiresAt={authExpiresAt}
      showIntro={showIntro}
      showPasswordChange={showPasswordChange}
      contentRef={contentRef}
      introTriggerRef={introTriggerRef}
      onNavigateStep={navigateStep}
      onResetWorkspace={() => { void resetWorkspace(); }}
      onToggleBanner={() => setBannerExpanded((value) => !value)}
      onDismissBanner={() => setBannerDismissed(true)}
      onShowIntro={() => setShowIntro(true)}
      onCloseIntro={() => setShowIntro(false)}
      onRequestPasswordChange={() => setShowPasswordChange(true)}
      onClosePasswordChange={() => setShowPasswordChange(false)}
      onPasswordChanged={passwordChanged}
      onLogout={logout}
    />
  );
}
