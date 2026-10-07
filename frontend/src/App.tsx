import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearAuthentication,
  clearAuthenticationIfCurrent,
  dropStepFromHistory,
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
  // Who was signed in when the session ended, so the login form returns to that account.
  // Read before the first render: the login form takes its initial value from it.
  const [authUsername] = useState<string | null>(() => sessionStorage.getItem("gvcsim_auth_username"));
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
    materialLocked: session.report?.state === "pending" || session.report?.state === "graded",
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

  const reloadLoggedOut = useCallback((notice?: string, username?: string) => {
    const activeToken = getActiveAuthToken();
    setActiveAuthToken(null);
    if (activeToken !== null) clearAuthenticationIfCurrent(sessionStorage, activeToken);
    else if (sessionStorage.getItem(AUTH_TOKEN_KEY) === null) clearAuthentication(sessionStorage);
    if (notice) sessionStorage.setItem("gvcsim_auth_notice", notice);
    // During startup the user is not known yet; fall back to the account signed in on this tab.
    const returning = username ?? sessionStorage.getItem("gvcsim_signed_in_username");
    if (notice && returning) sessionStorage.setItem("gvcsim_auth_username", returning);
    window.location.reload();
  }, []);

  const logout = useCallback(() => {
    void session.syncNow().catch(() => {
      // The next login in this tab puts the edits back.
      if (user?.role === "student") session.keepUnsavedEdits();
    }).finally(() => {
      // On a shared computer the next person must start from their own progress, not this
      // user's last step; an expired session (reloadLoggedOut alone) keeps the step for re-login.
      dropStepFromHistory(window.history, window.location.href);
      reloadLoggedOut();
    });
  }, [reloadLoggedOut, session, user]);

  useEffect(() => {
    const notice = sessionStorage.getItem("gvcsim_auth_notice");
    if (notice) {
      sessionStorage.removeItem("gvcsim_auth_notice");
      setAuthNotice(notice);
    }
    sessionStorage.removeItem("gvcsim_auth_username");
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
    // Back after logout can restore a signed-in page from the back/forward cache with its token
    // still in memory; the tab's stored token is the truth, so reload when it is gone.
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted && getActiveAuthToken() !== null && sessionStorage.getItem(AUTH_TOKEN_KEY) !== getActiveAuthToken()) {
        setActiveAuthToken(null);
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  useEffect(() => {
    const expired = () => {
      if (user?.role === "student") session.keepUnsavedEdits();
      reloadLoggedOut("登录已失效，请重新登录。", user?.username);
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
      setFatal(userFacingRequestError(error, "读取课程数据失败"));
      setMetaReady(true);
    });
    if (user.role === "student") {
      api.steps().then(
        (value) => { if (live) setStepsData(value); },
        (error) => { if (live) setFatal(userFacingRequestError(error, "读取课程步骤失败")); },
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
      <LoginPage notice={authNotice} username={authUsername} onLogin={(response) => {
        storeAuthentication(sessionStorage, response.token);
        // Lets an expired session (even one found on reload) return the login form to this account.
        sessionStorage.setItem("gvcsim_signed_in_username", response.user.username);
        // 每次学生登录都重新展示系统介绍（不按账号记忆已读）；登录失效或改密后的重新登录是在实验中途，
        // 不再打断（authNotice 说明了为何回到登录页）。
        if (shouldAutoShowIntro(response.user.role) && !authNotice) {
          sessionStorage.setItem("gvcsim_show_intro", "1");
        }
        // A step in the URL left by the previous user (Back after logout) must not decide where this
        // login opens; only a re-login after an expired session returns to the step it left.
        if (!authNotice) dropStepFromHistory(window.history, window.location.href);
        window.location.reload();
      }} />
    );
  }

  const passwordChanged = () => {
    if (user.role === "student") session.keepUnsavedEdits();
    reloadLoggedOut("密码已修改。请使用新密码重新登录。", user.username);
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
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" onClick={() => { setFatal(null); setBootAttempt((value) => value + 1); }}>重试加载课程</button>
        <button className="secondary" onClick={logout}>退出登录</button>
      </div>
    </main>
  );
  if (!stepsData || !metaReady || session.status === "loading") return <AppBootSkeleton />;
  // Without the saved record every edit would be dropped (nothing can be merged or saved), so the
  // workspace must not look usable: block it until the record is read.
  if (session.status === "unavailable") return (
    <main className="app-boot" style={{ padding: 40 }}>
      <div className="error-box" role="alert">读取实验记录失败：{session.syncError ?? "暂时无法连接教学服务"}</div>
      <p>你的实验记录保存在服务器上，没有丢失。读取成功后才能继续操作。</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" onClick={session.retryLoad}>重新读取实验记录</button>
        <button className="secondary" onClick={logout}>退出登录</button>
      </div>
    </main>
  );

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
