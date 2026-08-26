import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { AccountPasswordModal } from "./account-password";
import {
  completedStepsForPresentation,
  completionForPresentation,
  effectiveCompletionBlockReason,
  type CompletionBlockState,
} from "./completion-block";
import {
  CourseSidebar,
  StepFooter,
  StepHeader,
  StepRail,
  StudentTopbar,
} from "./app-shell";
import { IntroOverlay } from "./intro";
import { LabRouter } from "./lab-router";
import type { RegressionHistory, RegressionSettings } from "./regression";
import { QuizPanel } from "./step-quiz";
import { ToastHost } from "./toast";
import type { AuthUser, Meta, StepsResponse, StepStateApi } from "./types";
import type { SessionApi } from "./use-session";

export function stepMainContentId(step: number): string {
  return `step-${step}-main-content`;
}

export function focusStepMainContent(
  event: Pick<MouseEvent<HTMLAnchorElement>, "preventDefault">,
  target: Pick<HTMLElement, "focus" | "scrollIntoView"> | null,
): void {
  if (!target) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
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
  const steps = stepsData.steps;
  const totalSteps = steps.length;
  const stepIndex = steps.findIndex((item) => item.n === current);
  const visitRef = useRef({ step: current, visit: 0 });
  if (visitRef.current.step !== current) {
    visitRef.current = { step: current, visit: visitRef.current.visit + 1 };
  }
  const visit = visitRef.current.visit;
  const [completionBlock, setCompletionBlock] = useState<CompletionBlockState | null>(null);
  const updateCompletionBlock = useCallback((reason: string | null) => {
    setCompletionBlock({ step: current, visit, reason });
  }, [current, visit]);
  if (stepIndex < 0) {
    return <div style={{ padding: 40 }} className="error-box">步骤不存在，请从课程大纲重新选择。</div>;
  }
  const step = steps[stepIndex];
  const stageName = stepsData.stages[String(step.stage)];
  const prevStep = steps[stepIndex - 1];
  const nextStep = steps[stepIndex + 1];
  // 回归工作台自带完整渐进教学结构，主区跳过通用讲解卡避免重复。
  const isReg = step.lab === "reg";
  // 可视化步骤(viz)图表是主角:讲解卡默认折叠,给图表让出首屏纵向空间(可点开)
  const isViz = step.lab === "viz";
  const activeCompletionBlockReason = effectiveCompletionBlockReason(step, completionBlock, visit);
  const presentationCompletion = completionForPresentation(
    session.completion,
    step.n,
    activeCompletionBlockReason,
  );
  const presentationCompletedSteps = completedStepsForPresentation(
    completedSteps,
    step.n,
    activeCompletionBlockReason,
  );
  const mainContentId = stepMainContentId(step.n);

  return (
    <>
      <div className="layout" inert={showIntro ? true : undefined}>
        <StudentWorkspaceSkipLink targetId={mainContentId} targetRef={contentRef} />
        <StudentTopbar
          user={user}
          meta={meta}
          authExpiresAt={authExpiresAt}
          introTriggerRef={introTriggerRef}
          onShowIntro={onShowIntro}
          onRequestPasswordChange={onRequestPasswordChange}
          onLogout={onLogout}
        />

        <div className="main">
          <CourseSidebar
            stepsData={stepsData}
            current={current}
            completion={presentationCompletion}
            onNavigate={onNavigateStep}
          />

          <div className="workarea">
            {session.authRecoveryAvailable && (
              <div className="warnbox persistent-qc-warning" role="alert">
                <b>找到上次登录失效前未保存的本地内容。</b>
                <p>旧令牌不会重试。你可以用当前账号显式恢复并保存这份内容，或放弃它并继续使用服务器版本。</p>
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
                    : "本地记录仍在，可以直接重试。"}
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
              <main id={mainContentId} ref={contentRef} className="content" tabIndex={-1}>
                <div className="content-inner">
                  {/* 已把 concept 并入页内 StepIntro(常驻)的步骤,这里不再重复渲染讲解卡:
                      可视化(isViz)、指标计算(ind)、政策冲击接入(shock);回归自带渐进教学,也跳过。 */}
                  {!isReg && !isViz && step.lab !== "ind" && step.lab !== "shock" && (
                    <details className="card accent concept-card" open>
                      <summary className="kicker">讲解</summary>
                      <p>{step.concept}</p>
                    </details>
                  )}
                  <LabRouter
                    key={`lab:${step.n}:${session.workspaceGeneration}`}
                    step={step}
                    meta={meta}
                    state={stepState}
                    report={session.report}
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
                    onCompletionBlockChange={updateCompletionBlock}
                    getStep={session.getStep}
                    getConfirmedStep={session.getConfirmedStep}
                  />
                  <QuizPanel
                    key={`quiz:${step.n}:${session.workspaceGeneration}`}
                    step={step}
                    state={stepState}
                    completionBlockedReason={activeCompletionBlockReason}
                  />
                </div>
              </main>

              <StepRail
                step={step}
                previous={prevStep}
                next={nextStep}
                stageName={stageName}
                totalSteps={totalSteps}
                onNavigate={onNavigateStep}
              />
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
        <AccountPasswordModal onClose={onClosePasswordChange} onChanged={onPasswordChanged} />
      )}
    </>
  );
}
