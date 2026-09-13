import { DbLab, IndicatorLab, ReportLab, ShockLab, VizLab } from "./labs";
import {
  RegressionRunLab,
  type RegressionHistory,
  type RegressionSettings,
} from "./regression";
import type { SiblingStepData } from "./regression-teach";
import type { ClassroomReport, Meta, ReportGateItem, ReportMutationResponse, Step, StepStateApi } from "./types";
import type { SessionStatus } from "./use-session";
import type { Dispatch, SetStateAction } from "react";

interface LabRouterProps {
  step: Step;
  meta: Meta | null;
  state: StepStateApi;
  report: ClassroomReport | null;
  sessionUpdatedAt?: string | null;
  reportGate: ReportGateItem[] | null;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  sessionSyncError: string | null;
  onFlushSession: () => Promise<void>;
  onReportChanged: (response: ReportMutationResponse) => void;
  regressionSettings: RegressionSettings;
  onRegressionSettingsChange: (settings: RegressionSettings) => void;
  regressionHistory: RegressionHistory;
  onRegressionHistoryChange: Dispatch<SetStateAction<RegressionHistory>>;
  onNavigateStep: (step: number) => void;
  getStep?: <T>(step: number) => T | undefined;
  getConfirmedStep?: <T>(step: number) => T | undefined;
}

/** Map the course contract's lab key to one isolated interactive workbench. */
export function LabRouter({
  step,
  meta,
  state,
  report,
  sessionUpdatedAt,
  reportGate,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  sessionSyncError,
  onFlushSession,
  onReportChanged,
  regressionSettings,
  onRegressionSettingsChange,
  regressionHistory,
  onRegressionHistoryChange,
  onNavigateStep,
  getStep,
  getConfirmedStep,
}: LabRouterProps) {
  if (step.lab === "db") return <DbLab state={state} releaseMeta={meta} />;
  if (step.lab === "shock") return meta ? <ShockLab meta={meta} step={step} state={state} /> : null;
  // 同一实验台横跨多步时必须按步重挂载，否则步内状态会泄漏到下一步。
  if (step.lab === "ind") return meta ? <IndicatorLab key={step.n} meta={meta} step={step} state={state} /> : null;
  if (step.lab === "viz") return meta ? <VizLab key={step.n} meta={meta} step={step} state={state} /> : null;
  if (step.lab === "reg") {
    return (
      <RegressionRunLab
        key={step.regression_outcome}
        step={step}
        state={state}
        settings={regressionSettings}
        onSettingsChange={onRegressionSettingsChange}
        history={regressionHistory}
        onHistoryChange={onRegressionHistoryChange}
        getConfirmedStep={getConfirmedStep}
        sessionUnsynced={sessionUnsynced}
        sessionSyncing={sessionSyncing}
        sessionSyncError={sessionSyncError}
      />
    );
  }
  if (step.lab === "rep") {
    return (
      <ReportLab
        key="report"
        state={state}
        report={report}
        sessionUpdatedAt={sessionUpdatedAt}
        reportGate={reportGate}
        sessionStatus={sessionStatus}
        sessionUnsynced={sessionUnsynced}
        sessionSyncing={sessionSyncing}
        onFlushSession={onFlushSession}
        onNavigateStep={onNavigateStep}
        onReportChanged={onReportChanged}
        getStep={getConfirmedStep
          ? (n) => getConfirmedStep<SiblingStepData>(n)
          : getStep ? (n) => getStep<SiblingStepData>(n) : undefined}
      />
    );
  }
  return null;
}
