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
  stepPrimaryActionLabel,
  STEP_MATERIAL_ACTION_ID,
  STEP_PRIMARY_ACTION_ID,
  StepTaskCard,
} from "./step-task-card";
import { SyncProblemBanner, SyncProblemContext, type SyncProblem } from "./sync-problem";
import { ToastHost } from "./toast";
import type { AuthUser, Meta, StepsResponse, StepStateApi } from "./types";
import type { SessionApi } from "./use-session";

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
/** Country A stays first: steps 3–5 compare a pair (A, B); steps 6–9 take up to five economies. */
export function carriedComparisonFor(
  step: number,
  current: readonly string[],
  savedComparison: (prior: number) => unknown,
): string[] {
  if (step < 3 || step > 9 || current.length >= 2) return [];
  for (let prior = step - 1; prior >= 2; prior -= 1) {
    const candidates = savedComparison(prior);
    if (Array.isArray(candidates) && candidates.length >= 2) {
      const unique = candidates.filter((code, index): code is string =>
        typeof code === "string" && candidates.indexOf(code) === index);
      if (unique.length >= 2) return unique.slice(0, step <= 5 ? 2 : 5);
    }
  }
  return [];
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
      contentRef.current?.focus();
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
  const materialStatus = materialStatusForStep(step.n, session.materialGate,
    session.unsynced || session.syncing, Boolean(session.syncError));
  const currentComparison = session.getStep<{ compared?: string[] }>(step.n)?.compared ?? [];
  // Steps 3–9 record their comparison as soon as they open, so a step visited for the first time starts
  // from the comparison used in the latest earlier step instead of the default CHN/USA. Once the step saves
  // its own comparison, that one is used.
  const carriedComparison = carriedComparisonFor(step.n, currentComparison,
    (prior) => session.getStep<{ compared?: string[] }>(prior)?.compared);
  const labState: typeof stepState = carriedComparison.length >= 2
    ? {
      ...stepState,
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
              onNavigate={onNavigateStep}
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
