import {
  FAMILY_STEPS,
  familyDirectionLabel,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
} from "./regression-lessons";
import { buildRegressionVerdict } from "./regression-verdict";
import type { RegressionOutcome, RegressionResponse } from "./types";

type FamilyHistory = Partial<Record<RegressionOutcome, Array<{ response: RegressionResponse }>>>;

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

function familyRun(outcome: RegressionOutcome, history: FamilyHistory, getStep?: (step: number) => SiblingStepData | undefined): SavedRegression | undefined {
  const data = getStep?.(FAMILY_STEPS[outcome]);
  if (data?.run?.result?.diagnostics?.study_contract === "economics-v2") return data.run;
  // A chosen session (including an empty step after conflict resolution) is
  // authoritative. History alone is a fallback only without a session reader.
  return data?.qualified_run ?? data?.run ?? (getStep ? undefined : history[outcome]?.[0]?.response);
}

export function familyVerdict(
  outcome: RegressionOutcome,
  history: FamilyHistory,
  getStep?: (step: number) => SiblingStepData | undefined,
) {
  return verdictFromSaved(outcome, familyRun(outcome, history, getStep));
}

export function RegressionEvidenceMatrix({
  history = {},
  getStep,
  current,
}: {
  history?: FamilyHistory;
  getStep?: (step: number) => SiblingStepData | undefined;
  current?: RegressionOutcome;
}) {
  return (
    <section className="reg-evidence-matrix" aria-labelledby="reg-evidence-matrix-title">
      <div className="reg-evidence-matrix-head">
        <div>
          <span className="reg-section-step">四步证据总表</span>
          <h3 id="reg-evidence-matrix-title">并排读方向、不确定性、单位和边界</h3>
        </div>
        <p>不同指标的系数不能比大小；空白表示该步还没有可用结果。</p>
      </div>
      <div className="table-wrap" role="region" aria-label="四步证据总表，可横向滚动" tabIndex={0}>
        <table className="data-table reg-evidence-table">
          <thead>
            <tr><th>步骤</th><th>指标家族</th><th>比较设定</th><th>方向判断</th><th>效应与单位</th><th>95% 区间</th><th>写作边界</th></tr>
          </thead>
          <tbody>
            {REGRESSION_FAMILIES.map((item) => {
              const verdict = familyVerdict(item.outcome, history, getStep);
              const lesson = REGRESSION_LESSONS[item.outcome];
              const design = familyRun(item.outcome, history, getStep)?.design;
              return (
                <tr key={item.outcome} className={item.outcome === current ? "current" : undefined}>
                  <th scope="row">{item.step}</th>
                  <td><b>{item.family}</b><span>{lesson.shortMetric}</span></td>
                  <td>{design ? <>
                    模拟关税暴露强度
                    <span>连续强度 TWFE</span>
                    <span>国家×行业 · 教学模拟</span>
                    <span>固定处理前权重</span>
                  </> : "—"}</td>
                  <td>{verdict ? familyDirectionLabel(verdict.state) : "待估计"}</td>
                  <td><b>{verdict?.effect ?? "—"}</b></td>
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
