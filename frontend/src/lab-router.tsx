import { DbLab, IndicatorLab, QcLab, ReportLab, ShockLab, VizLab } from "./labs";
import {
  RegressionRunLab,
  type RegressionHistory,
  type RegressionSettings,
} from "./regression";
import type { Meta, Step, StepStateApi } from "./types";
import type { SessionStatus } from "./use-session";
import type { Dispatch, SetStateAction } from "react";

interface LabRouterProps {
  step: Step;
  meta: Meta | null;
  state: StepStateApi;
  completionKey: string;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  sessionSyncError: string | null;
  onFlushSession: () => Promise<void>;
  /** 服务端状态变化后（如生成报告）重新装载完成度。 */
  onCompletionChanged: () => Promise<void>;
  regressionSettings: RegressionSettings;
  onRegressionSettingsChange: (settings: RegressionSettings) => void;
  regressionHistory: RegressionHistory;
  onRegressionHistoryChange: Dispatch<SetStateAction<RegressionHistory>>;
  onNavigateStep: (step: number) => void;
}

/** Map the course contract's lab key to one isolated interactive workbench. */
export function LabRouter({
  step,
  meta,
  state,
  completionKey,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  sessionSyncError,
  onFlushSession,
  onCompletionChanged,
  regressionSettings,
  onRegressionSettingsChange,
  regressionHistory,
  onRegressionHistoryChange,
  onNavigateStep,
}: LabRouterProps) {
  if (step.lab === "db") return <DbLab state={state} />;
  if (step.lab === "qc") return meta ? <QcLab meta={meta} onNavigateStep={onNavigateStep} /> : null;
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
      />
    );
  }
  if (step.lab === "rep") {
    return (
      <ReportLab
        key="report"
        state={state}
        completionKey={completionKey}
        sessionStatus={sessionStatus}
        sessionUnsynced={sessionUnsynced}
        sessionSyncing={sessionSyncing}
        sessionSyncError={sessionSyncError}
        onFlushSession={onFlushSession}
        onNavigateStep={onNavigateStep}
        onGenerated={onCompletionChanged}
      />
    );
  }
  return null;
}
