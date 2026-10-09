import {
  FAMILY_STEPS,
  familyDirectionLabel,
  lessonFor,
  REGRESSION_FAMILIES,
} from "./regression-lessons";
import { BAR_UNIT_TITLES, barFigures, buildRegressionVerdict, depvarKind, globalInferenceIsSuppressed, SD_DEFINITION } from "./regression-verdict";
import type { RegressionOutcome, RegressionResponse } from "./types";
import { DivergingBarChart, type DivergingBarRow } from "./viz/regression/diverging-bars";

interface SavedRegression {
  design?: RegressionResponse["design"];
  result?: RegressionResponse["result"];
}

export interface SiblingStepData {
  run?: SavedRegression;
  qualified_run?: SavedRegression;
}

const SAVED_BENCHMARK: RegressionResponse["benchmark"] = {
  backend: "saved",
  policy_coefs: [],
  max_abs_coef_diff: 0,
  max_abs_se_diff: 0,
  coef_check_passed: true,
  se_check_mode: "informational",
  notes: [],
};

function verdictFromSaved(outcome: RegressionOutcome, saved: SavedRegression | undefined) {
  if (!saved?.design || !saved?.result) return null;
  return buildRegressionVerdict(outcome, {
    design: saved.design,
    result: saved.result,
    benchmark: SAVED_BENCHMARK,
    disclaimer: "",
  });
}

/** Each step's own saved run is the only source; steps 11–14 never read each other. */
function familyRun(outcome: RegressionOutcome, getStep?: (step: number) => SiblingStepData | undefined): SavedRegression | undefined {
  const data = getStep?.(FAMILY_STEPS[outcome]);
  if (data?.run?.result?.diagnostics?.study_contract === "economics-v2") return data.run;
  return data?.qualified_run ?? data?.run;
}

export function familyVerdict(
  outcome: RegressionOutcome,
  getStep?: (step: number) => SiblingStepData | undefined,
) {
  return verdictFromSaved(outcome, familyRun(outcome, getStep));
}

/**
 * The four saved estimates as four bars on one axis. Their units differ, so each bar is the standardized size
 * ((β × 0.01) / sd(Y): Y's gap in standard deviations per 1 percentage point of X), and its end gives the native
 * value with its unit and the signed size ("-0.55 个百分点（-0.062 个标准差）"). Each bar is the step's SAVED run, as in the report.
 */
export function regressionSummaryRows(getStep?: (step: number) => SiblingStepData | undefined): { rows: DivergingBarRow[]; missing: string[] } {
  const rows: DivergingBarRow[] = [];
  const missing: string[] = [];
  for (const family of REGRESSION_FAMILIES) {
    const run = familyRun(family.outcome, getStep);
    if (!run?.design || !run.result) {
      missing.push(`步骤 ${family.step} · ${family.family}`);
      continue;
    }
    const coefficient = run.result.coefs[0] ?? null;
    const suppressed = globalInferenceIsSuppressed(run.result.status, run.result.support);
    const figures = barFigures({
      coef: coefficient?.coef ?? null, ci_low: coefficient?.ci_low ?? null, ci_high: coefficient?.ci_high ?? null,
      depvar_std: run.result.depvar_std ?? null, suppressed,
    }, depvarKind(family.outcome, run.design), "sd", true);
    rows.push({
      key: family.outcome,
      label: lessonFor(family.outcome, run.design.baseline, run.design.baseline_label).shortMetric,
      sublabel: `步骤 ${family.step} · ${family.family}`,
      ...figures,
      note: suppressed ? "这次的数据不够判断方向，不显示 95% 区间" : undefined,
    });
  }
  return { rows, missing };
}

export function RegressionSummaryBars({ getStep }: { getStep?: (step: number) => SiblingStepData | undefined }) {
  const { rows, missing } = regressionSummaryRows(getStep);
  return (
    <div className="reg-summary-bars">
      {rows.length > 0 && <DivergingBarChart rows={rows} unitTitle={BAR_UNIT_TITLES.sd} title="四步保存的结果（都换算成标准差）" />}
      {missing.length > 0 && <p className="muted reg-family-missing">{missing.join("、")}：还没计算</p>}
    </div>
  );
}

/** Report-page summary of the four saved regression steps. */
export function RegressionEvidenceMatrix({
  getStep,
}: {
  getStep?: (step: number) => SiblingStepData | undefined;
}) {
  return (
    <section className="reg-evidence-matrix" aria-labelledby="reg-evidence-matrix-title">
      <div className="reg-evidence-matrix-head">
        <div>
          <span className="reg-section-step">四步结果汇总</span>
          <h3 id="reg-evidence-matrix-title">比较方向、不确定性和单位</h3>
        </div>
        <p>四个 Y 的单位不同，数字不能直接比较大小（括号里换算成标准差，{SD_DEFINITION}）；“—”表示该步还没有结果。四步用同一个模型，只换 Y。</p>
      </div>
      <div className="table-wrap" role="region" aria-label="四步结果汇总表，可横向滚动" tabIndex={0}>
        <table className="data-table reg-evidence-table">
          <thead>
            <tr><th>步骤</th><th>指标类型</th><th>方向</th><th>X 每高 1 个百分点，Y 平均相差</th><th>95% 区间</th><th>解释限制</th></tr>
          </thead>
          <tbody>
            {REGRESSION_FAMILIES.map((item) => {
              const verdict = familyVerdict(item.outcome, getStep);
              const design = familyRun(item.outcome, getStep)?.design;
              const lesson = lessonFor(item.outcome, design?.baseline, design?.baseline_label);
              return (
                <tr key={item.outcome}>
                  <th scope="row">{item.step}</th>
                  <td><b>{item.family}</b><span>{lesson.shortMetric}</span></td>
                  <td>{verdict ? (verdict.coefficient ? familyDirectionLabel(verdict.state) : "没算出估计值") : "还没计算"}</td>
                  <td><b>{verdict?.effectBrief ?? "—"}</b></td>
                  <td>{verdict?.interval ?? "—"}</td>
                  <td>{lesson.dontClaim}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
