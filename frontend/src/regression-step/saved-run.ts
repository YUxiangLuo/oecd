/** What a step keeps of its one run (the course default model on the step's default Y) and how it is restored. */
import type { QuizCompletionState, RegressionResponse } from "../types";

export const TEACHING_MODEL_VERSION = "step10-tariff-teaching-v13";

/** 自动保存最近一次真实运行，供刷新恢复与报告复估。 */
export interface SavedRegressionRun {
  design: RegressionResponse["design"];
  result: RegressionResponse["result"];
  /** Server-provided data and interpretation boundary; persisted verbatim for restored runs. */
  disclaimer: string;
  /** Required for current teaching runs; optional only so old snapshots can be detected and rejected. */
  model_snapshot?: NonNullable<RegressionResponse["model_snapshot"]>;
  variable_catalog?: NonNullable<RegressionResponse["variable_catalog"]>;
}

export interface RegressionStepState extends QuizCompletionState, Record<string, unknown> {
  /** The step's one saved run: the course default model on the step's default Y (the report material). */
  run?: SavedRegressionRun;
}

const SAVED_REGRESSION_BENCHMARK: RegressionResponse["benchmark"] = {
  backend: "saved",
  policy_coefs: [],
  max_abs_coef_diff: 0,
  max_abs_se_diff: 0,
  coef_check_passed: true,
  se_check_mode: "informational",
  notes: [],
};

export function savedRegressionResponse(saved: SavedRegressionRun): RegressionResponse {
  return {
    design: saved.design,
    result: saved.result,
    benchmark: SAVED_REGRESSION_BENCHMARK,
    disclaimer: saved.disclaimer,
    model_snapshot: saved.model_snapshot,
    variable_catalog: saved.variable_catalog,
  };
}

function canonicalSnapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0);
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalSnapshot(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic identity of every saved setting, design field, and result field. */
export function regressionRunSnapshotIdentity(saved: SavedRegressionRun): string {
  return canonicalSnapshot({
    design: saved.design,
    result: saved.result,
    disclaimer: saved.disclaimer,
    model_snapshot: saved.model_snapshot,
    variable_catalog: saved.variable_catalog,
  });
}

