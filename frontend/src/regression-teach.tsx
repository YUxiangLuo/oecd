import {
  FAMILY_STEPS,
  familyDirectionLabel,
  lessonFor,
  REGRESSION_FAMILIES,
} from "./regression-lessons";
import { buildRegressionVerdict, chartDisplayScale } from "./regression-verdict";
import type { RegressionOutcome, RegressionResponse } from "./types";
import { CoefForestChart } from "./viz";

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

/** The four saved estimates side by side, each on its own axis because their units differ. */
export function RegressionFamilyPanels({ getStep }: { getStep?: (step: number) => SiblingStepData | undefined }) {
  return (
    <div className="reg-family-panels">
      {REGRESSION_FAMILIES.map((family) => {
        const run = familyRun(family.outcome, getStep);
        const coefficient = run?.result?.coefs[0];
        const display = chartDisplayScale(family.outcome, run?.design);
        return run?.result && coefficient ? (
          <CoefForestChart
            key={family.outcome}
            coefs={[coefficient]}
            globalStatus={run.result.status}
            globalSupport={run.result.support}
            scale={display.scale}
            unit={display.unit}
            labels={{ teaching_tariff_exposure: lessonFor(family.outcome, run.design?.baseline, run.design?.baseline_label).shortMetric }}
            title={`步骤 ${family.step} · ${family.family}`}
          />
        ) : <div key={family.outcome} className="muted reg-family-missing">步骤 {family.step} · {family.family}：还没有可用结果</div>;
      })}
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
              const lesson = lessonFor(item.outcome, design?.baseline, design?.baseline_label);
              return (
                <tr key={item.outcome}>
                  <th scope="row">{item.step}</th>
                  <td><b>{item.family}</b><span>{lesson.shortMetric}</span></td>
                  <td>{design ? <>
                    关税暴露 X
                    <span>连续强度 TWFE</span>
                    <span>国家×行业</span>
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
