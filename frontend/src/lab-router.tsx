import { DbLab, IndicatorLab, ReportLab, ShockLab, VizLab } from "./labs";
import {
  RegressionRunLab,
} from "./regression";
import type { SiblingStepData } from "./regression-teach-logic";
import type { ClassroomReport, Meta, ReportGateItem, Step, StepStateApi } from "./types";
import type { ReportActions, SessionStatus } from "./use-session";
import type { ReactNode } from "react";

interface LabRouterProps {
  /** The course\'s steps, for step 15\'s 你记录的材料 table. */
  steps?: Step[];
  /** The step's quiz panel; a regression step places it after its result, before the optional workbench. */
  quiz?: ReactNode;
  step: Step;
  meta: Meta | null;
  state: StepStateApi;
  report: ClassroomReport | null;
  reportCurrent?: boolean | null;
  reportGate: ReportGateItem[] | null;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  reportActions: ReportActions;
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
  reportCurrent,
  reportGate,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  reportActions,
  onNavigateStep,
  getStep,
  getConfirmedStep,
  quiz,
  steps,
}: LabRouterProps) {
  if (step.lab === "db") return <DbLab state={state} releaseMeta={meta} />;
  if (step.lab === "shock") return meta ? <ShockLab meta={meta} step={step} state={state} /> : null;
  // 同一实验台横跨多步时必须按步重挂载，否则步内状态会泄漏到下一步。
  if (step.lab === "ind") return meta ? <IndicatorLab key={step.n} meta={meta} step={step} state={state} /> : null;
  if (step.lab === "viz") return meta ? <VizLab key={step.n} meta={meta} step={step} state={state} /> : null;
  if (step.lab === "reg") {
    return meta ? (
      <RegressionRunLab
        key={step.regression_outcome}
        step={step}
        quiz={quiz}
        meta={meta}
        state={state}
        getStep={getStep}
        // Same "report needs update" signal as the sidebar and step 15, plus what the report was built from.
        reportCustomResults={report?.provenance.custom_results}
        reportOutdated={Boolean(report) && (sessionUnsynced || sessionSyncing || reportCurrent === false)}
      />
    ) : null;
  }
  if (step.lab === "rep") {
    return (
      <ReportLab
        key="report"
        steps={steps}
        state={state}
        report={report}
        reportCurrent={reportCurrent}
        reportGate={reportGate}
        sessionStatus={sessionStatus}
        sessionUnsynced={sessionUnsynced}
        sessionSyncing={sessionSyncing}
        reportActions={reportActions}
        onNavigateStep={onNavigateStep}
        getStep={getConfirmedStep
          ? (n) => getConfirmedStep<SiblingStepData>(n)
          : getStep ? (n) => getStep<SiblingStepData>(n) : undefined}
      />
    );
  }
  return null;
}
