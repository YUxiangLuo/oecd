import {
  useRef,
  useMemo,
  useState,
  type Dispatch,
  type MouseEvent,
  type RefObject,
  type SetStateAction,
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
import type { RegressionHistory, RegressionSettings } from "./regression";
import { QuizPanel, type QuizDraftStore } from "./step-quiz";
import {
  materialStatusForStep,
  stepPrimaryActionLabel,
  STEP_PRIMARY_ACTION_ID,
  StepTaskCard,
} from "./step-task-card";
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
  regressionSettings: RegressionSettings;
  onRegressionSettingsChange: (settings: RegressionSettings) => void;
  regressionHistory: RegressionHistory;
  onRegressionHistoryChange: Dispatch<SetStateAction<RegressionHistory>>;
  authExpiresAt: number | null;
  showIntro: boolean;
  showPasswordChange: boolean;
  contentRef: RefObject<HTMLElement | null>;
  introTriggerRef: RefObject<HTMLButtonElement | null>;
  onNavigateStep: (step: number) => void;
  onShowIntro: () => void;
  onCloseIntro: () => void;
  onRequestPasswordChange: () => void;
  onClosePasswordChange: () => void;
  onPasswordChanged: () => void;
  onLogout: () => void;
}

/** Loaded student course shell. Data loading and all state ownership stay in App. */
export function StudentWorkspace({
  user,
  meta,
  stepsData,
  current,
  session,
  stepState,
  completedSteps,
  regressionSettings,
  onRegressionSettingsChange,
  regressionHistory,
  onRegressionHistoryChange,
  authExpiresAt,
  showIntro,
  showPasswordChange,
  contentRef,
  introTriggerRef,
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
  const [comparisonCarryGeneration, setComparisonCarryGeneration] = useState(0);
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
  const currentComparison = session.getStep<{ compared?: string[] }>(step.n)?.compared ?? [];
  let carriedComparison: string[] = [];
  if (step.n >= 3 && step.n <= 9 && currentComparison.length < 2) {
    for (let prior = step.n - 1; prior >= 2; prior -= 1) {
      const candidates = session.getStep<{ compared?: string[] }>(prior)?.compared;
      if (Array.isArray(candidates) && candidates.length >= 2) {
        carriedComparison = candidates.slice(-2);
        break;
      }
    }
  }

  return (
    <>
      <div className="layout" inert={showIntro ? true : undefined}>
        <StudentWorkspaceSkipLink targetId={mainContentId} targetRef={contentRef} />
        <StudentTopbar
          user={user}
          meta={meta}
          authExpiresAt={authExpiresAt}
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
          />

          <div className="workarea">
            {session.authRecoveryAvailable && (
              <div className="warnbox persistent-qc-warning" role="alert">
                <b>找到上次刷新、离开或登录失效前尚未确认保存的本地内容。</b>
                <p>只会使用当前已校验的账号与数据版本。你可以显式恢复并保存，或放弃本地内容；恢复仍需核对服务器记录版本，不会自动覆盖更新。</p>
                <div className="button-row">
                  <button
                    type="button"
                    className="primary"
                    disabled={session.syncing}
                    onClick={() => { void session.restoreAuthRecovery().catch(() => {}); }}
                  >
                    {session.syncing ? "正在恢复并保存…" : "恢复未保存内容"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={session.syncing}
                    onClick={session.discardAuthRecovery}
                  >
                    放弃本地内容
                  </button>
                </div>
              </div>
            )}
            {session.syncError && (
              <div className="error-box persistent-qc-warning" role="alert">
                <b>实验记录尚未同步到服务器。</b>
                <p>
                  {session.syncError}{" "}
                  {session.syncConflict
                    ? "本页未保存内容仍在当前画面中；载入服务器版本后，请重新执行本页操作。"
                    : "本地记录仍在，可以直接重试。刷新会尝试在本标签页保留草稿，关闭标签页仍可能丢失。"}
                </p>
                <button
                  type="button"
                  className="secondary"
                  disabled={session.syncing}
                  onClick={() => {
                    void (session.syncConflict ? session.resolveSyncConflict() : session.syncNow()).catch(() => {});
                  }}
                >
                  {session.syncing
                    ? session.syncConflict ? "正在载入…" : "正在重试…"
                    : session.syncConflict ? "载入服务器版本" : "重试保存"}
                </button>
              </div>
            )}
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
                    materialStatus={materialStatusForStep(
                      step.n,
                      session.materialGate,
                      session.unsynced || session.syncing,
                  Boolean(session.syncError),
                    )}
                    contentRef={contentRef}
                  />
                  {carriedComparison.length >= 2 && (
                    <div className="comparison-carry" role="note">
                      <div>
                        <b>保持同一组比较对象</b>
                        <span>上一页使用了 {carriedComparison.join(" / ")}；沿用后可在本步继续追踪同一条证据链，也可稍后主动更换。</span>
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          stepState.save({ compared: carriedComparison });
                          setComparisonCarryGeneration((value) => value + 1);
                        }}
                      >
                        沿用并记录到本步
                      </button>
                    </div>
                  )}
                  <div
                    id={STEP_PRIMARY_ACTION_ID}
                    tabIndex={-1}
                    className="step-primary-action"
                    role="region"
                    aria-label={stepPrimaryActionLabel(step)}
                  >
                    <LabRouter
                      key={`lab:${step.n}:${session.workspaceGeneration}:${comparisonCarryGeneration}`}
                      step={step}
                      meta={meta}
                      state={stepState}
                      report={session.report}
                      sessionUpdatedAt={session.updatedAt}
                      reportGate={session.reportGate}
                      sessionStatus={session.status}
                      sessionUnsynced={session.unsynced}
                      sessionSyncing={session.syncing}
                      sessionSyncError={session.syncError}
                      onFlushSession={session.syncNow}
                      onReportChanged={session.applyReportMutation}
                      regressionSettings={regressionSettings}
                      onRegressionSettingsChange={onRegressionSettingsChange}
                      regressionHistory={regressionHistory}
                      onRegressionHistoryChange={onRegressionHistoryChange}
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
          returnFocusRef={introTriggerRef}
          onDone={(gotoStep) => {
            onCloseIntro();
            if (gotoStep) onNavigateStep(gotoStep);
          }}
        />
      )}
      {showPasswordChange && (
        <AccountPasswordModal
          onClose={onClosePasswordChange}
          onChanged={onPasswordChanged}
          returnFocusRef={passwordTriggerRef}
        />
      )}
    </>
  );
}
