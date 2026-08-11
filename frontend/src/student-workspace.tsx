import type { Dispatch, RefObject, SetStateAction } from "react";
import { AccountPasswordModal } from "./account-password";
import {
  AnnouncementBanner,
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
import type { Announcement, AuthUser, Meta, StepsResponse, StepStateApi } from "./types";
import type { SessionApi } from "./use-session";

interface StudentWorkspaceProps {
  user: AuthUser;
  meta: Meta | null;
  stepsData: StepsResponse;
  current: number;
  maxStep: number;
  session: SessionApi;
  stepState: StepStateApi;
  completionKey: string;
  completedSteps: Set<number>;
  regressionSettings: RegressionSettings;
  onRegressionSettingsChange: (settings: RegressionSettings) => void;
  regressionHistory: RegressionHistory;
  onRegressionHistoryChange: Dispatch<SetStateAction<RegressionHistory>>;
  announcements: Announcement[];
  bannerDismissed: boolean;
  bannerExpanded: boolean;
  resettingWorkspace: boolean;
  resetWorkspaceError: string | null;
  authExpiresAt: number | null;
  showIntro: boolean;
  showPasswordChange: boolean;
  contentRef: RefObject<HTMLElement | null>;
  introTriggerRef: RefObject<HTMLButtonElement | null>;
  onNavigateStep: (step: number) => void;
  onResetWorkspace: () => void;
  onToggleBanner: () => void;
  onDismissBanner: () => void;
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
  maxStep,
  session,
  stepState,
  completionKey,
  completedSteps,
  regressionSettings,
  onRegressionSettingsChange,
  regressionHistory,
  onRegressionHistoryChange,
  announcements,
  bannerDismissed,
  bannerExpanded,
  resettingWorkspace,
  resetWorkspaceError,
  authExpiresAt,
  showIntro,
  showPasswordChange,
  contentRef,
  introTriggerRef,
  onNavigateStep,
  onResetWorkspace,
  onToggleBanner,
  onDismissBanner,
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
          onResetWorkspace={onResetWorkspace}
          onShowIntro={onShowIntro}
          onRequestPasswordChange={onRequestPasswordChange}
          onLogout={onLogout}
        />

        {resetWorkspaceError && (
          <div className="error-box workspace-reset-error" role="alert">清空实验失败：{resetWorkspaceError}</div>
        )}

        {!bannerDismissed && (
          <AnnouncementBanner
            announcements={announcements}
            expanded={bannerExpanded}
            onToggle={onToggleBanner}
            onDismiss={onDismissBanner}
          />
        )}

        <div className="main">
          <CourseSidebar
            stepsData={stepsData}
            current={current}
            maxStep={maxStep}
            completion={session.completion}
            onNavigate={onNavigateStep}
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
              onNavigate={onNavigateStep}
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
                    onRegressionSettingsChange={onRegressionSettingsChange}
                    regressionHistory={regressionHistory}
                    onRegressionHistoryChange={onRegressionHistoryChange}
                    onNavigateStep={onNavigateStep}
                  />
                  <QuizPanel key={step.n} step={step} state={stepState} />
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
              maxStep={maxStep}
              completedSteps={completedSteps}
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
