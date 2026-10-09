import {
  useEffect,
  useRef,
  useMemo,
  type MouseEvent,
  type RefObject,
} from "react";
import { AccountPasswordModal } from "./account-password";
import {
  CourseSidebar,
  StepFooter,
  StepHeader,
  StudentTopbar,
} from "./app-shell";
import { IntroOverlay } from "./intro";
import { LabRouter } from "./lab-router";
import { QuizPanel, type QuizDraftStore } from "./step-quiz";
import {
  focusStepPrimaryAction,
  materialStatusForStep,
  reportMaterialStatus,
  stepPrimaryActionLabel,
  STEP_MATERIAL_ACTION_ID,
  STEP_PRIMARY_ACTION_ID,
  StepTaskCard,
} from "./step-task-card";
import { SyncProblemBanner, SyncProblemContext, type SyncProblem } from "./sync-problem";
import { ToastHost } from "./toast";
import type { AuthUser, Meta, StepsResponse, StepStateApi } from "./types";
import type { SessionApi } from "./use-session";
import { defaultPartner } from "./labs/steps/viz/indicator-model";

export function stepMainContentId(step: number): string {
  return `step-${step}-main-content`;
}

export function focusStepMainContent(
  event: Pick<MouseEvent<HTMLAnchorElement>, "preventDefault">,
  target: Pick<HTMLElement, "focus" | "scrollTo"> | null,
): void {
  if (!target) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  target.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

export function StudentWorkspaceSkipLink({
  targetId,
  targetRef,
}: {
  targetId: string;
  targetRef: RefObject<HTMLElement | null>;
}) {
  return (
    <a
      className="skip-to-step-content"
      href={`#${targetId}`}
      onClick={(event) => focusStepMainContent(event, targetRef.current)}
    >
      跳到本步内容
    </a>
  );
}

interface StudentWorkspaceProps {
  user: AuthUser;
  meta: Meta | null;
  stepsData: StepsResponse;
  current: number;
  session: SessionApi;
  stepState: StepStateApi;
  completedSteps: Set<number>;
  showIntro: boolean;
  showPasswordChange: boolean;
  contentRef: RefObject<HTMLElement | null>;
  introTriggerRef: RefObject<HTMLButtonElement | null>;
  /** The intro opened by itself after login; closing it returns focus to the step content. */
  introAuto?: boolean;
  onNavigateStep: (step: number) => void;
  onShowIntro: () => void;
  onCloseIntro: () => void;
  onRequestPasswordChange: () => void;
  onClosePasswordChange: () => void;
  onPasswordChanged: () => void;
  onLogout: () => void;
}

/** Loaded student course shell. Data loading and all state ownership stay in App. */
/**
 * The comparison a step opens with before it saves its own, carried from the latest earlier step that has one.
 * Steps 2–5 record one country (records saved before that may hold two): steps 3–5 carry that country.
 * Steps 6–9 compare country A with up to four others: they carry an earlier step 6–9 list as it is, and from a
 * steps 2–5 record take its country as A, with the default comparison country B unless a B was saved there.
 */
export function carriedComparisonFor(
  step: number,
  current: readonly string[],
  savedComparison: (prior: number) => unknown,
  countries: readonly string[] = [],
): string[] {
  return carriedComparisonSource(step, current, savedComparison, countries)?.compared ?? [];
}

/** {@link carriedComparisonFor} with the earlier step it came from, so a step can say where its country came from. */
export function carriedComparisonSource(
  step: number,
  current: readonly string[],
  savedComparison: (prior: number) => unknown,
  countries: readonly string[] = [],
): { compared: string[]; from: number } | null {
  const singleCountry = step <= 5;
  if (step < 3 || step > 9 || current.length >= (singleCountry ? 1 : 2)) return null;
  for (let prior = step - 1; prior >= 2; prior -= 1) {
    const candidates = savedComparison(prior);
    if (!Array.isArray(candidates)) continue;
    const unique = candidates.filter((code, index): code is string =>
      typeof code === "string" && code !== "" && code !== "ROW" && candidates.indexOf(code) === index);
    if (prior <= 5) {
      if (unique.length === 0) continue;
      if (singleCountry) return { compared: unique.slice(0, 1), from: prior };
      if (unique.length >= 2) return { compared: unique.slice(0, 2), from: prior };
      const partner = countries.length ? defaultPartner(countries.filter((code) => code !== "ROW"), unique[0]) : "";
      return { compared: partner ? [unique[0], partner] : [unique[0]], from: prior };
    }
    if (unique.length >= 2) return { compared: unique.slice(0, 5), from: prior };
  }
  return null;
}

export function StudentWorkspace({
  user,
  meta,
  stepsData,
  current,
  session,
  stepState,
  completedSteps,
  showIntro,
  showPasswordChange,
  contentRef,
  introTriggerRef,
  introAuto = false,
  onNavigateStep,
  onShowIntro,
  onCloseIntro,
  onRequestPasswordChange,
  onClosePasswordChange,
  onPasswordChanged,
  onLogout,
}: StudentWorkspaceProps) {
  const quizDrafts = useMemo<QuizDraftStore>(() => new Map(), [user.account_id, session.workspaceGeneration]);
  const steps = stepsData.steps;
  const totalSteps = steps.length;
  const stepIndex = steps.findIndex((item) => item.n === current);
  const passwordTriggerRef = useRef<HTMLButtonElement>(null);
  // A save problem that clears (retry, automatic resave when back online) unmounts its banner and the
  // button that had focus; continue from the step content instead of <body>.
  const hadSyncError = useRef(false);
  useEffect(() => {
    const failing = Boolean(session.syncError);
    if (hadSyncError.current && !failing && (document.activeElement == null || document.activeElement === document.body)) {
      // An open fullscreen panel is a dialog: keep focus inside it rather than behind it.
      const panel = document.querySelector<HTMLElement>(".fullscreen-panel--expanded .fullscreen-panel-surface");
      if (panel) {
        if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
        panel.focus({ preventScroll: true });
      } else contentRef.current?.focus();
    }
    hadSyncError.current = failing;
  }, [session.syncError, contentRef]);
  if (stepIndex < 0) {
    return <div style={{ padding: 40 }} className="error-box">步骤不存在，请从课程大纲重新选择。</div>;
  }
  const step = steps[stepIndex];
  const stageName = stepsData.stages[String(step.stage)];
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  const presentationCompletion = session.completion;
  const presentationCompletedSteps = completedSteps;
  const mainContentId = stepMainContentId(step.n);
  const materialStatus = step.lab === "rep"
    ? reportMaterialStatus(session.reportGate, session.unsynced || session.syncing, Boolean(session.syncError))
    : materialStatusForStep(step.n, session.materialGate, session.unsynced || session.syncing, Boolean(session.syncError));
  const currentComparison = session.getStep<{ compared?: string[] }>(step.n)?.compared ?? [];
  // Steps 3–9 record their country (steps 3–5) or comparison (steps 6–9) as soon as they open, so a step
  // visited for the first time starts from the country used in the latest earlier step instead of the default
  // CHN (and USA). Once the step saves its own, that one is used.
  const carried = carriedComparisonSource(step.n, currentComparison,
    (prior) => session.getStep<{ compared?: string[] }>(prior)?.compared, meta?.countries ?? []);
  const carriedComparison = carried?.compared ?? [];
  const labState: typeof stepState = carried && carriedComparison.length >= 1
    ? {
      ...stepState,
      // Lets the step say where its opening country came from (steps 3–5 show it beside the country select).
      carriedFrom: carried.from,
      data: {
        ...(stepState.data ?? {}),
        compared: carriedComparison,
        country: typeof stepState.data?.country === "string" ? stepState.data.country : carriedComparison[0],
      },
    }
    : stepState;

  const syncProblem: SyncProblem = {
    error: session.syncError,
    conflict: session.syncConflict,
    syncing: session.syncing,
    act: () => {
      if (!session.syncConflict) {
        void session.syncNow().catch(() => {});
        return;
      }
      // Loading the server version remounts the step (a fullscreen panel closes with it), so the button
      // that had focus is gone: move focus to the step's main content instead of leaving it on <body>.
      void session.resolveSyncConflict().catch(() => {}).finally(() => {
        window.requestAnimationFrame(() => contentRef.current?.focus());
      });
    },
  };

  return (
    <SyncProblemContext.Provider value={syncProblem}>
      <div className="layout" inert={showIntro ? true : undefined}>
        <StudentWorkspaceSkipLink targetId={mainContentId} targetRef={contentRef} />
        {/* Always mounted, so a step change is announced even though focus stays in the sidebar. */}
        <span className="sr-only" role="status" aria-live="polite">已进入步骤 {step.n}：{step.title}</span>
        <StudentTopbar
          user={user}
          meta={meta}
          introTriggerRef={introTriggerRef}
          passwordTriggerRef={passwordTriggerRef}
          onShowIntro={onShowIntro}
          onRequestPasswordChange={onRequestPasswordChange}
          onLogout={onLogout}
        />

        <div className="main">
          <CourseSidebar
            stepsData={stepsData}
            current={current}
            completion={presentationCompletion}
            materialGate={session.materialGate}
            onNavigate={onNavigateStep}
            reportExists={session.report != null}
            reportState={session.report?.state}
            currentMaterialStatus={materialStatus}
          />

          <div className="workarea">
            <SyncProblemBanner problem={syncProblem} />
            <StepHeader
              step={step}
              previous={prevStep}
              next={nextStep}
              stageName={stageName}
              totalSteps={totalSteps}
              onNavigate={onNavigateStep}
            />
            <div className="content-row">
              <main
                id={mainContentId}
                ref={contentRef}
                className="content"
                tabIndex={-1}
                aria-labelledby="current-step-heading"
              >
                <div className="content-inner">
                  <StepTaskCard
                    step={step}
                    complete={presentationCompletedSteps.has(step.n)}
                    materialStatus={materialStatus}
                    reportExists={session.report != null}
                    reportState={session.report?.state}
                  />
                  <div
                    id={STEP_PRIMARY_ACTION_ID}
                    tabIndex={-1}
                    className="step-primary-action"
                    role="region"
                    aria-label={stepPrimaryActionLabel(step)}
                  >
                    <LabRouter
                      key={`lab:${step.n}:${session.workspaceGeneration}`}
                      step={step}
                      meta={meta}
                      state={labState}
                      report={session.report}
                      sessionUpdatedAt={session.updatedAt}
                      reportCurrent={session.completion?.steps.find((item) => item.step === 15)?.complete ?? null}
                      reportGate={session.reportGate}
                      sessionStatus={session.status}
                      sessionUnsynced={session.unsynced}
                      sessionSyncing={session.syncing}
                      onFlushSession={session.syncNow}
                      onReportChanged={session.applyReportMutation}
                      onNavigateStep={onNavigateStep}
                      getStep={session.getStep}
                      getConfirmedStep={session.getConfirmedStep}
                    />
                  </div>
                  <QuizPanel
                    key={`quiz:${step.n}:${session.workspaceGeneration}`}
                    draftStore={quizDrafts}
                    step={step}
                    state={stepState}
                    materialStatus={materialStatus}
                    onRecordMaterials={step.n >= 2 && step.n <= 4
                      ? () => { focusStepPrimaryAction(contentRef.current, STEP_MATERIAL_ACTION_ID); }
                      : undefined}
                    next={nextStep}
                    onNavigate={(n) => {
                      // Like the footer: the button leaves with the old step, so focus starts at the new step's top.
                      onNavigateStep(n);
                      window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
                    }}
                  />
                </div>
              </main>

            </div>

            <StepFooter
              steps={steps}
              step={step}
              next={nextStep}
              stageName={stageName}
              current={current}
              completedSteps={presentationCompletedSteps}
              onNavigate={(n) => {
                // The footer sits below the step: after moving on, keyboard focus starts at the new step's top.
                onNavigateStep(n);
                window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
              }}
            />
          </div>
        </div>
        {/* 学生端 ToastHost:与教师端实例互斥,任一时刻只挂载一个。 */}
        <ToastHost />
      </div>
      {showIntro && (
        <IntroOverlay
          user={user}
          meta={meta}
          stepsData={stepsData}
          returnFocusRef={introAuto ? contentRef : introTriggerRef}
          onDone={onCloseIntro}
        />
      )}
      {showPasswordChange && (
        <AccountPasswordModal
          onClose={onClosePasswordChange}
          onChanged={onPasswordChanged}
          returnFocusRef={passwordTriggerRef}
        />
      )}
    </SyncProblemContext.Provider>
  );
}
