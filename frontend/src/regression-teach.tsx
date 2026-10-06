import {
  FAMILY_STEPS,
  familyDirectionLabel,
  lessonFor,
  REGRESSION_FAMILIES,
} from "./regression-lessons";
import { buildRegressionVerdict } from "./regression-verdict";
import type { RegressionOutcome, RegressionResponse } from "./types";

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
        <p>不同指标的系数不能比大小；空白表示该步还没有可用结果。</p>
      </div>
      <div className="table-wrap" role="region" aria-label="四步结果汇总表，可横向滚动" tabIndex={0}>
        <table className="data-table reg-evidence-table">
          <thead>
            <tr><th>步骤</th><th>指标类型</th><th>模型设置</th><th>方向</th><th>估计值与单位</th><th>标称 95% 近似区间</th><th>解释限制</th></tr>
          </thead>
          <tbody>
            {REGRESSION_FAMILIES.map((item) => {
              const verdict = familyVerdict(item.outcome, getStep);
              const design = familyRun(item.outcome, getStep)?.design;
              const lesson = lessonFor(item.outcome, design?.baseline);
              return (
                <tr key={item.outcome}>
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
