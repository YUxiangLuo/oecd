import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearAuthentication,
  clearAuthenticationIfCurrent,
  isExternalAuthenticationChange,
  markIntroSeen,
  readAuthExpiry,
  shouldAutoShowIntro,
  stepFromSearch,
  storeAuthentication,
  writeStepHistory,
  type StepHistoryMode,
} from "./app-state";
import { AppBootSkeleton, TeacherWorkspace } from "./app-shell";
import { AUTH_TOKEN_KEY, api, getActiveAuthToken, isApiErrorStatus, setActiveAuthToken } from "./api";
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
import type { AuthUser, Meta, StepsResponse, StepStateApi } from "./types";
import { useSession } from "./use-session";
import { userFacingRequestError } from "./user-facing-error";

export default function App() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaReady, setMetaReady] = useState(false);
  const explicitStep = useRef(stepFromSearch(window.location.search));
  const initialStepChosen = useRef(false);
  const [current, setCurrent] = useState(() => explicitStep.current ?? 1);
  const contentRef = useRef<HTMLElement>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(() => !localStorage.getItem(AUTH_TOKEN_KEY));
  const [authExpiresAt] = useState<number | null>(() => readAuthExpiry(localStorage));
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authCheckError, setAuthCheckError] = useState<string | null>(null);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showIntro, setShowIntro] = useState(() => sessionStorage.getItem("gvcsim_show_intro") === "1");
  const introTriggerRef = useRef<HTMLButtonElement>(null);

  const session = useSession(
    user?.role === "student",
    user?.role === "student" ? user.username : undefined,
  );
  const currentOutcome = stepsData?.steps.find((step) => step.n === current)?.regression_outcome;
  const regressionSettings =
    (currentOutcome && asRegressionSettingsMap(session.getShared("regression_settings"))[currentOutcome])
    || (currentOutcome ? SIGNATURE_SETTINGS[currentOutcome] : DEFAULT_REGRESSION_SETTINGS);
  const [regressionHistory, setRegressionHistory] = useState<RegressionHistory>({});
  const setRegressionSettings = useCallback((next: RegressionSettings) => {
    if (!currentOutcome) return;
    session.updateShared("regression_settings", (stored) => ({
      ...asRegressionSettingsMap(stored),
      [currentOutcome]: next,
    }));
  }, [currentOutcome, session]);

  const completedSteps = new Set(session.completion?.completed ?? []);
  const currentCompletion = session.completion?.steps.find((item) => item.step === current);
  const stepState: StepStateApi = {
    data: session.getStep(current),
    save: (patch) => session.patchStep(current, patch),
    complete: currentCompletion?.complete ?? false,
    syncing: session.syncing,
    syncError: session.syncError,
    syncNow: () => { void session.syncNow().catch(() => {}); },
  };

  const resolveStep = useCallback((next: number) => {
    const available = stepsData?.steps ?? [];
    const last = available.at(-1)?.n ?? 15;
    const bounded = Math.max(1, Math.min(last, next));
    return available.length && !available.some((item) => item.n === bounded)
      ? (available[0]?.n ?? 1)
      : bounded;
  }, [stepsData]);

  const selectStep = useCallback((next: number, historyMode: StepHistoryMode) => {
    const target = resolveStep(next);
    resetStepScroller(contentRef.current);
    initialStepChosen.current = true;
    setCurrent(target);
    writeStepHistory(window.history, window.location.href, target, historyMode);
  }, [resolveStep]);

  const navigateStep = useCallback((next: number) => {
    selectStep(next, "push");
  }, [selectStep]);

  useEffect(() => {
    const restoreHistoryStep = () => {
      const requested = stepFromSearch(window.location.search);
      const target = resolveStep(requested ?? 1);
      resetStepScroller(contentRef.current);
      initialStepChosen.current = true;
      setCurrent(target);
      writeStepHistory(window.history, window.location.href, target, "replace");
    };
    window.addEventListener("popstate", restoreHistoryStep);
    return () => window.removeEventListener("popstate", restoreHistoryStep);
  }, [resolveStep]);

  const reloadLoggedOut = useCallback((notice?: string) => {
    const activeToken = getActiveAuthToken();
    setActiveAuthToken(null);
    if (activeToken !== null) clearAuthenticationIfCurrent(localStorage, activeToken);
    else if (localStorage.getItem(AUTH_TOKEN_KEY) === null) clearAuthentication(localStorage);
    if (notice) sessionStorage.setItem("gvcsim_auth_notice", notice);
    window.location.reload();
  }, []);

  const logout = useCallback(() => {
    void session.syncNow().catch(() => {
      if (user?.role === "student") session.stashAuthRecovery(user.username);
    }).finally(() => reloadLoggedOut());
  }, [reloadLoggedOut, session, user]);

  useEffect(() => {
    const notice = sessionStorage.getItem("gvcsim_auth_notice");
    if (notice) {
      sessionStorage.removeItem("gvcsim_auth_notice");
      setAuthNotice(notice);
    }
    if (sessionStorage.getItem("gvcsim_show_intro") === "1") {
      sessionStorage.removeItem("gvcsim_show_intro");
    }
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) {
      setActiveAuthToken(null);
      setAuthChecked(true);
      return;
    }
    setActiveAuthToken(token);
    api.me(token).then(
      (verifiedUser) => { if (getActiveAuthToken() === token) setUser(verifiedUser); },
      (error) => {
        if (getActiveAuthToken() !== token) return;
        if (isApiErrorStatus(error, 401)) reloadLoggedOut("登录已过期，请重新登录。");
        else setAuthCheckError(userFacingRequestError(error, "暂时无法校验登录"));
      },
    ).finally(() => setAuthChecked(true));
  }, [reloadLoggedOut]);

  useEffect(() => {
    const preserveUnsyncedStudentWork = () => {
      if (user?.role === "student") session.stashAuthRecovery(user.username);
    };
    const expired = () => {
      preserveUnsyncedStudentWork();
      reloadLoggedOut("登录已过期，请重新登录。");
    };
    const storageChanged = (event: StorageEvent) => {
      if (!isExternalAuthenticationChange(event.key, event.newValue, getActiveAuthToken())) return;
      preserveUnsyncedStudentWork();
      // 先切断当前页面的请求身份，再重新挂载新账号或登录页。
      setActiveAuthToken(null);
      window.location.reload();
    };
    window.addEventListener("gvcsim-auth-expired", expired);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("gvcsim-auth-expired", expired);
      window.removeEventListener("storage", storageChanged);
    };
  }, [reloadLoggedOut, session, user]);

  useEffect(() => {
    if (!user) return;
    let live = true;
    api.meta().then((value) => {
      if (!live) return;
      setMeta(value);
      setMetaReady(true);
    }, (error) => {
      if (!live) return;
      setFatal(String(error.message ?? error));
      setMetaReady(true);
    });
    if (user.role === "student") {
      api.steps().then(
        (value) => { if (live) setStepsData(value); },
        (error) => { if (live) setFatal(String(error.message ?? error)); },
      );
    }
    return () => { live = false; };
  }, [user]);

  useEffect(() => {
    if (!stepsData || session.status !== "ready" || initialStepChosen.current) return;
    initialStepChosen.current = true;
    if (explicitStep.current != null) return;
    const completed = new Set(session.completion?.completed ?? []);
    const firstIncomplete = stepsData.steps.find((step) => !completed.has(step.n))?.n ?? stepsData.steps[0]?.n ?? 1;
    selectStep(firstIncomplete, "replace");
  }, [selectStep, session.completion, session.status, stepsData]);

  if (!authChecked) return <AppBootSkeleton />;
  if (authCheckError) {
    return (
      <main className="layout app-boot" style={{ display: "grid", placeItems: "center", padding: 32 }}>
        <section className="panel" role="alert" style={{ maxWidth: 560 }}>
          <h1>暂时无法连接教学服务</h1>
          <p>{authCheckError}</p>
          <p>登录信息已保留。服务恢复后可重试连接。</p>
          <button className="primary" onClick={() => window.location.reload()}>重试连接</button>
        </section>
      </main>
    );
  }
  if (!user) {
    return (
      <LoginPage notice={authNotice} onLogin={(response) => {
        storeAuthentication(localStorage, response.token, response.expires_at);
        if (response.user.role === "student" && shouldAutoShowIntro(localStorage, response.user.username)) {
          sessionStorage.setItem("gvcsim_show_intro", "1");
        }
        window.location.reload();
      }} />
    );
  }

  const passwordChanged = () => {
    if (user.role === "student") session.stashAuthRecovery(user.username);
    reloadLoggedOut("密码已修改。请使用新密码重新登录。");
  };
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

  if (fatal) return <div style={{ padding: 40 }}><div className="error-box">无法连接后端 API：{fatal}</div></div>;
  if (!stepsData || !metaReady || session.status === "loading") return <AppBootSkeleton />;

  return (
    <StudentWorkspace
      user={user}
      meta={meta}
      stepsData={stepsData}
      current={current}
      session={session}
      stepState={stepState}
      completedSteps={completedSteps}
      regressionSettings={regressionSettings}
      onRegressionSettingsChange={setRegressionSettings}
      regressionHistory={regressionHistory}
      onRegressionHistoryChange={setRegressionHistory}
      authExpiresAt={authExpiresAt}
      showIntro={showIntro}
      showPasswordChange={showPasswordChange}
      contentRef={contentRef}
      introTriggerRef={introTriggerRef}
      onNavigateStep={navigateStep}
      onShowIntro={() => setShowIntro(true)}
      onCloseIntro={() => {
        markIntroSeen(localStorage, user.username);
        setShowIntro(false);
      }}
      onRequestPasswordChange={() => setShowPasswordChange(true)}
      onClosePasswordChange={() => setShowPasswordChange(false)}
      onPasswordChanged={passwordChanged}
      onLogout={logout}
    />
  );
}
