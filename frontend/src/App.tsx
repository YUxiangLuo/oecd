import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearAuthentication,
  clearAuthenticationIfCurrent,
  dropStepFromHistory,
  LOGGED_OUT_HERE_KEY,
  shouldAutoShowIntro,
  shouldDropStepOnLogin,
  stepFromSearch,
  stepLinkNotice,
  storeAuthentication,
  writeStepHistory,
  type StepHistoryMode,
} from "./app-state";
import { AppBootSkeleton, NarrowWindowNotice, TeacherWorkspace } from "./app-shell";
import { AUTH_TOKEN_KEY, api, getActiveAuthToken, isApiErrorStatus, setActiveAuthToken } from "./api";
import { LoginPage } from "./login";
import { resetStepScroller } from "./step-navigation";
import { StudentWorkspace } from "./student-workspace";
import type { AuthUser, Meta, StepsResponse, StepStateApi } from "./types";
import { expiredLoginNotice, hasKeptEdits, SAVE_RETRY_DELAYS_MS, useSession } from "./use-session";
import { userFacingRequestError } from "./user-facing-error";

const APP_TITLE = "供应链仿真系统 · GVC Simulation Lab";

/** One layout for the three start-up failures: a heading, what failed, what is kept, and the actions. */
function BootFailure({ title, message, note, primary, secondary }: {
  title: string;
  message: string;
  note: string;
  primary: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <main className="layout app-boot boot-failure">
      <section className="panel" aria-labelledby="boot-failure-title">
        <h1 id="boot-failure-title">{title}</h1>
        <div className="error-box" role="alert">{message}</div>
        <p>{note}</p>
        <div className="boot-failure-actions">
          {/* Focus lands here after each failed retry, so a keyboard user is not left on <body>. */}
          <button className="primary" autoFocus onClick={primary.onClick}>{primary.label}</button>
          {secondary && <button className="secondary" onClick={secondary.onClick}>{secondary.label}</button>}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  // Outside every branch, so login, failure pages and both workspaces get it alike.
  return <><NarrowWindowNotice /><AppContent /></>;
}

function AppContent() {
  const [stepsData, setStepsData] = useState<StepsResponse | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaReady, setMetaReady] = useState(false);
  const initialSearch = useRef(window.location.search);
  const explicitStep = useRef(stepFromSearch(initialSearch.current));
  // Said once, on the step the link opened: a ?step= that is not a course step was replaced by another one.
  const [stepNotice, setStepNotice] = useState<{ step: number; text: string } | null>(null);
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
  const [authAttempt, setAuthAttempt] = useState(0);
  // After a successful retry the failure page (and its focused button) is gone: put focus on the content.
  const recoverFocus = useRef(false);
  // An automatic retry runs behind its failure page: the page stays (no loading screen, no new alert, focus where it
  // was) until the retry succeeds. A click on the page's button shows the loading screen as before.
  const quietAuthRetry = useRef(false);
  const quietBootRetry = useRef(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showIntro, setShowIntro] = useState(() => sessionStorage.getItem("gvcsim_show_intro") === "1");
  const introTriggerRef = useRef<HTMLButtonElement>(null);
  // Shown by itself after login (not from the 系统介绍 button): closing it continues on the step content.
  const [introAuto, setIntroAuto] = useState(showIntro);

  const session = useSession(
    user?.role === "student",
    user?.role === "student" ? user.username : undefined,
  );

  useEffect(() => {
    void session.refreshLearning?.().catch(() => {});
  }, [current, session.refreshLearning]);

  const completedSteps = new Set(session.completion?.completed ?? []);
  const currentCompletion = session.completion?.steps.find((item) => item.step === current);
  const stepState: StepStateApi = {
    data: session.getStep(current),
    save: (patch) => session.patchStep(current, patch),
    saveView: (patch) => session.patchStep(current, patch),
    complete: currentCompletion?.complete ?? false,
    syncing: session.syncing,
    syncError: session.saveError,
    materialPending: session.hasMaterialChanges(current),
    materialSyncError: session.hasMaterialChanges(current) ? session.saveError : null,
    syncConflict: session.syncConflict,
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
    if (session.reportOperation) return;
    const target = resolveStep(next);
    resetStepScroller(contentRef.current);
    initialStepChosen.current = true;
    setCurrent(target);
    writeStepHistory(window.history, window.location.href, target, historyMode);
  }, [resolveStep, session.reportOperation]);

  const navigateStep = useCallback((next: number) => {
    selectStep(next, "push");
  }, [selectStep]);

  useEffect(() => {
    const restoreHistoryStep = () => {
      if (session.reportOperation) {
        writeStepHistory(window.history, window.location.href, current, "replace");
        return;
      }
      const requested = stepFromSearch(window.location.search);
      const target = resolveStep(requested ?? 1);
      resetStepScroller(contentRef.current);
      initialStepChosen.current = true;
      setCurrent(target);
      writeStepHistory(window.history, window.location.href, target, "replace");
    };
    window.addEventListener("popstate", restoreHistoryStep);
    return () => window.removeEventListener("popstate", restoreHistoryStep);
  }, [resolveStep, current, session.reportOperation]);

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
    let kept = false;
    void session.syncNow().catch(() => {
      // The next login in this tab puts the edits back.
      if (user?.role === "student") kept = session.keepUnsavedEdits();
    }).finally(() => {
      // On a shared computer the next person must start from their own progress, not this
      // user's last step; an expired session (reloadLoggedOut alone) keeps the step for re-login.
      dropStepFromHistory(window.history, window.location.href);
      sessionStorage.setItem(LOGGED_OUT_HERE_KEY, "1");
      if (navigator.onLine) {
        reloadLoggedOut();
        return;
      }
      // Offline a reload lands on the browser's own error page; show the login form in place instead.
      const activeToken = getActiveAuthToken();
      setActiveAuthToken(null);
      if (activeToken !== null) clearAuthenticationIfCurrent(sessionStorage, activeToken);
      setAuthNotice(kept
        ? "已退出登录。现在没有网络，未保存的修改还在本页；联网后在这里重新登录，就会自动保存。"
        : "已退出登录。现在没有网络，联网后才能重新登录。");
      setUser(null);
    });
  }, [reloadLoggedOut, session, user]);

  useEffect(() => {
    const quiet = quietAuthRetry.current;
    quietAuthRetry.current = false;
    if (authAttempt > 0 && !quiet) setAuthCheckError(null);
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
      setAuthCheckError(null);
      setAuthChecked(true);
      return;
    }
    setActiveAuthToken(token);
    api.me(token).then(
      (verifiedUser) => {
        if (getActiveAuthToken() !== token) return;
        setAuthCheckError(null);
        setUser(verifiedUser);
      },
      (error) => {
        if (getActiveAuthToken() !== token) return;
        if (isApiErrorStatus(error, 401)) reloadLoggedOut(expiredLoginNotice(hasKeptEdits(sessionStorage, sessionStorage.getItem("gvcsim_signed_in_username"))));
        else setAuthCheckError(userFacingRequestError(error, "暂时无法确认登录状态"));
      },
    ).finally(() => setAuthChecked(true));
  }, [reloadLoggedOut, authAttempt]);

  // Both failure pages retry by themselves when the network comes back (the session page already does).
  const retryAuthCheck = useCallback(() => {
    recoverFocus.current = true;
    setAuthChecked(false);
    setAuthAttempt((value) => value + 1);
  }, []);
  const retryCourse = useCallback(() => {
    recoverFocus.current = true;
    setFatal(null);
    setBootAttempt((value) => value + 1);
  }, []);
  // Also on a timer (soon at first, then once a minute): a server that was down comes back without any "online"
  // event in a browser that stayed online.
  useEffect(() => {
    if (!authCheckError && !fatal) return;
    const retry = () => {
      recoverFocus.current = true;
      if (authCheckError) {
        quietAuthRetry.current = true;
        setAuthAttempt((value) => value + 1);
      } else {
        quietBootRetry.current = true;
        setBootAttempt((value) => value + 1);
      }
    };
    const attempt = authCheckError ? authAttempt : bootAttempt;
    const timer = window.setTimeout(retry, SAVE_RETRY_DELAYS_MS[Math.min(attempt, SAVE_RETRY_DELAYS_MS.length - 1)]);
    window.addEventListener("online", retry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }, [authAttempt, authCheckError, bootAttempt, fatal]);

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
      const kept = user?.role === "student" && session.keepUnsavedEdits();
      reloadLoggedOut(expiredLoginNotice(kept || hasKeptEdits(sessionStorage, user?.username ?? sessionStorage.getItem("gvcsim_signed_in_username"))), user?.username);
    };
    window.addEventListener("gvcsim-auth-expired", expired);
    return () => window.removeEventListener("gvcsim-auth-expired", expired);
  }, [reloadLoggedOut, session, user]);

  useEffect(() => {
    if (!user) return;
    let live = true;
    const quiet = quietBootRetry.current;
    quietBootRetry.current = false;
    if (!quiet) setFatal(null);
    setMetaReady(false);
    // Each load says whether it succeeded, so a quiet retry clears the failure page only once both did.
    const metaLoaded = api.meta().then((value) => {
      if (!live) return false;
      setMeta(value);
      setMetaReady(true);
      return true;
    }, (error) => {
      if (!live) return false;
      setFatal(userFacingRequestError(error, "读取课程数据失败"));
      setMetaReady(true);
      return false;
    });
    const stepsLoaded = user.role !== "student" ? Promise.resolve(true) : api.steps().then(
      (value) => {
        if (live) setStepsData(value);
        return live;
      },
      (error) => {
        if (live) setFatal(userFacingRequestError(error, "读取课程步骤失败"));
        return false;
      },
    );
    if (quiet) {
      void Promise.all([metaLoaded, stepsLoaded]).then((loaded) => { if (live && loaded.every(Boolean)) setFatal(null); });
    }
    return () => { live = false; };
  }, [user, bootAttempt]);

  useEffect(() => {
    if (!stepsData || session.status !== "ready" || initialStepChosen.current) return;
    initialStepChosen.current = true;
    const completed = new Set(session.completion?.completed ?? []);
    // A deep link keeps its step; the history entry is rewritten for it (as every other step change is).
    // Without one, open the first unfinished step; with everything done, the report step: that is where the
    // receipt and teacher feedback are.
    const target = resolveStep(explicitStep.current
      ?? stepsData.steps.find((step) => !completed.has(step.n))?.n ?? stepsData.steps.at(-1)?.n ?? 1);
    selectStep(target, "replace");
    const notice = stepLinkNotice(initialSearch.current, target);
    if (notice) setStepNotice({ step: target, text: notice });
  }, [resolveStep, selectStep, session.completion, session.status, stepsData]);

  // Each step gets its own tab title, so history entries and assistive tech can tell steps apart.
  const currentTitle = user?.role === "student" ? stepsData?.steps.find((item) => item.n === current)?.title : undefined;
  const isTeacher = user?.role === "teacher";
  useEffect(() => {
    // The teacher dashboard titles its own tabs (teacher/index.tsx); this parent effect would run after it.
    if (isTeacher) return;
    document.title = currentTitle ? `步骤 ${current} · ${currentTitle} · ${APP_TITLE}` : APP_TITLE;
  }, [current, currentTitle, isTeacher]);

  // After a failure page's retry succeeds, its focused button is gone; continue from the step content. The record's
  // own page retries inside useSession, so its showing is what marks the focus to recover.
  useEffect(() => {
    if (session.status === "unavailable") recoverFocus.current = true;
  }, [session.status]);
  const workspaceReady = Boolean(user?.role === "student" && stepsData && metaReady && session.status === "ready");
  useEffect(() => {
    if (!workspaceReady || !recoverFocus.current) return;
    recoverFocus.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement == null || document.activeElement === document.body) contentRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [workspaceReady]);

  if (!authChecked) return <AppBootSkeleton />;
  if (authCheckError) {
    return (
      <BootFailure
        title="暂时无法连接教学服务"
        message={authCheckError}
        note={`登录信息已保留。连接恢复后会自动重试，也可以点下方按钮再试。${authAttempt > 0 ? `已重试 ${authAttempt} 次。` : ""}`}
        primary={{ label: "重试连接", onClick: retryAuthCheck }}
      />
    );
  }
  if (!user) {
    return (
      <LoginPage notice={authNotice} username={authUsername} onLogin={(response) => {
        storeAuthentication(sessionStorage, response.token);
        const dropStep = shouldDropStepOnLogin(
          sessionStorage.getItem(LOGGED_OUT_HERE_KEY) === "1",
          sessionStorage.getItem("gvcsim_signed_in_username"),
          response.user.username,
        );
        sessionStorage.removeItem(LOGGED_OUT_HERE_KEY);
        // Lets an expired session (even one found on reload) return the login form to this account.
        sessionStorage.setItem("gvcsim_signed_in_username", response.user.username);
        // 每次学生登录都重新展示系统介绍（不按账号记忆已读）；登录失效或改密后的重新登录是在实验中途，
        // 不再打断（authNotice 说明了为何回到登录页）。
        if (shouldAutoShowIntro(response.user.role) && (!authNotice || response.user.username !== authUsername)) {
          sessionStorage.setItem("gvcsim_show_intro", "1");
        }
        // A step left by the previous user (Back after logout, or another account after an expiry) must not
        // decide where this login opens; a deep link in a fresh tab and a same-user re-login keep it.
        if (dropStep) dropStepFromHistory(window.history, window.location.href);
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
        onLogout={() => logout()}
      />
    );
  }

  if (fatal) return (
    <BootFailure
      title="课程加载失败"
      message={fatal}
      note={`登录信息已保留。连接恢复后会自动重试，也可以点下方按钮再试。${bootAttempt > 0 ? `已重试 ${bootAttempt} 次。` : ""}`}
      primary={{ label: "重试加载", onClick: retryCourse }}
      secondary={{ label: "退出登录", onClick: () => logout() }}
    />
  );
  if (!stepsData || !metaReady || session.status === "loading") return <AppBootSkeleton />;
  // Until the saved record is loaded, edits cannot be accepted or safely saved, so the
  // workspace must not look usable: block it until the record is read.
  if (session.status === "unavailable") return (
    <BootFailure
      title="暂时无法读取实验记录"
      message={session.syncError ?? "读取实验记录失败：暂时无法连接服务器"}
      note={`你的实验记录保存在服务器上，没有丢失。读取成功后才能继续；连接恢复后会自动重新读取。${session.loadAttempts > 0 ? `已重试 ${session.loadAttempts} 次。` : ""}`}
      primary={{ label: "重试读取", onClick: () => { recoverFocus.current = true; session.retryLoad(); } }}
      secondary={{ label: "退出登录", onClick: () => logout() }}
    />
  );

  return (
    <StudentWorkspace
      user={user}
      meta={meta}
      stepsData={session.quizzes ? { ...stepsData, steps: stepsData.steps.map((step) => ({ ...step, quiz: session.quizzes![String(step.n)] })) } : stepsData}
      current={current}
      stepNotice={stepNotice?.step === current ? stepNotice.text : null}
      onDismissStepNotice={() => setStepNotice(null)}
      session={session}
      stepState={stepState}
      completedSteps={completedSteps}
      showIntro={showIntro}
      showPasswordChange={showPasswordChange}
      contentRef={contentRef}
      introTriggerRef={introTriggerRef}
      onNavigateStep={navigateStep}
      introAuto={introAuto}
      onShowIntro={() => { setIntroAuto(false); setShowIntro(true); }}
      onCloseIntro={() => {
        setShowIntro(false);
      }}
      onRequestPasswordChange={() => setShowPasswordChange(true)}
      onClosePasswordChange={() => setShowPasswordChange(false)}
      onPasswordChanged={passwordChanged}
      onLogout={() => logout()}
    />
  );
}
