import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearAuthentication,
  clearAuthenticationIfCurrent,
  shouldAutoShowIntro,
  stepFromSearch,
  storeAuthentication,
  writeStepHistory,
  type StepHistoryMode,
} from "./app-state";
import { AppBootSkeleton, TeacherWorkspace } from "./app-shell";
import { AUTH_TOKEN_KEY, api, getActiveAuthToken, isApiErrorStatus, setActiveAuthToken } from "./api";
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
  const [bootAttempt, setBootAttempt] = useState(0);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(() => !sessionStorage.getItem(AUTH_TOKEN_KEY));
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authCheckError, setAuthCheckError] = useState<string | null>(null);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showIntro, setShowIntro] = useState(() => sessionStorage.getItem("gvcsim_show_intro") === "1");
  const introTriggerRef = useRef<HTMLButtonElement>(null);

  const session = useSession(
    user?.role === "student",
    user?.role === "student" ? user.username : undefined,
  );

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
    if (activeToken !== null) clearAuthenticationIfCurrent(sessionStorage, activeToken);
    else if (sessionStorage.getItem(AUTH_TOKEN_KEY) === null) clearAuthentication(sessionStorage);
    if (notice) sessionStorage.setItem("gvcsim_auth_notice", notice);
    window.location.reload();
  }, []);

  const logout = useCallback(() => {
    void session.syncNow().catch(() => {
      if (user?.role === "student") session.stashAuthRecovery(user.username);
    }).finally(() => {
      // On a shared computer the next person must start from their own progress, not this
      // user's last step; an expired session (reloadLoggedOut alone) keeps the step for re-login.
      const url = new URL(window.location.href);
      url.searchParams.delete("step");
      window.history.replaceState(window.history.state, "", url);
      reloadLoggedOut();
    });
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
    const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
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
        if (isApiErrorStatus(error, 401)) reloadLoggedOut("登录已失效，请重新登录。");
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
      reloadLoggedOut("登录已失效，请重新登录。");
    };
    window.addEventListener("gvcsim-auth-expired", expired);
    return () => window.removeEventListener("gvcsim-auth-expired", expired);
  }, [reloadLoggedOut, session, user]);

  useEffect(() => {
    if (!user) return;
    let live = true;
    setFatal(null);
    setMetaReady(false);
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
  }, [user, bootAttempt]);

  useEffect(() => {
    if (!stepsData || session.status !== "ready" || initialStepChosen.current) return;
    initialStepChosen.current = true;
    if (explicitStep.current != null) return;
    const completed = new Set(session.completion?.completed ?? []);
    // With everything done, open the report step: that is where the receipt and teacher feedback are.
    const firstIncomplete = stepsData.steps.find((step) => !completed.has(step.n))?.n ?? stepsData.steps.at(-1)?.n ?? 1;
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
        storeAuthentication(sessionStorage, response.token);
        // 每次学生登录都重新展示系统介绍（不按账号记忆已读）。
        if (shouldAutoShowIntro(response.user.role)) {
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
        showPasswordChange={showPasswordChange}
        onRequestPasswordChange={() => setShowPasswordChange(true)}
        onClosePasswordChange={() => setShowPasswordChange(false)}
        onPasswordChanged={passwordChanged}
        onLogout={logout}
      />
    );
  }

  if (fatal) return (
    <main className="app-boot" style={{ padding: 40 }}>
      <div className="error-box" role="alert">课程加载失败：{fatal}</div>
      <p>登录信息已保留，可以重试加载课程。</p>
      <button className="primary" onClick={() => { setFatal(null); setBootAttempt((value) => value + 1); }}>重试加载课程</button>
    </main>
  );
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
      showIntro={showIntro}
      showPasswordChange={showPasswordChange}
      contentRef={contentRef}
      introTriggerRef={introTriggerRef}
      onNavigateStep={navigateStep}
      onShowIntro={() => setShowIntro(true)}
      onCloseIntro={() => {
        setShowIntro(false);
      }}
      onRequestPasswordChange={() => setShowPasswordChange(true)}
      onClosePasswordChange={() => setShowPasswordChange(false)}
      onPasswordChanged={passwordChanged}
      onLogout={logout}
    />
  );
}
