import { useId, useState } from "react";
import {
  FAMILY_STEPS,
  familyDirectionLabel,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
} from "./regression-lessons";
import { buildRegressionVerdict } from "./regression-verdict";
import type { RegressionOutcome, RegressionResponse } from "./types";

/** An isolated reading exercise: no session writes or report evidence. */
export function IntervalReadingExercise() {
  const name = useId();
  const [answer, setAnswer] = useState("");
  return <details className="technical-details reg-interval-exercise">
    <summary>可选小练习：都是负数，结论一样吗？</summary>
    <p className="muted">独立练习，不是本次回归结果；不计分、不影响完成进度，也不进入报告。</p>
    <p>假设下面两组都是“X 增加 1 个百分点时，Y 的平均变化”，单位均为百分点。</p>
    <div className="reg-variable-plain-grid">
      <div><b>例子 A</b><span>点估计 −0.40；95% 区间 [−0.70, −0.10]。</span></div>
      <div><b>例子 B</b><span>点估计 −0.40；95% 区间 [−0.90, +0.10]。</span></div>
    </div>
    <fieldset>
      <legend>按区间是否包含 0，哪组支持下降方向？</legend>
      {[
        ["both", "两组都支持，因为点估计都是负数"],
        ["a", "只有 A 支持，B 暂不能确定方向"],
        ["zero", "A 支持下降，B 证明没有变化"],
      ].map(([value, label]) => <label key={value}>
        <input type="radio" name={name} value={value} checked={answer === value} onChange={() => setAnswer(value)} />
        <span>{label}</span>
      </label>)}
    </fieldset>
    {answer && <p role="status" className="reg-writing-hint">
      <b>{answer === "a" ? "答对了。" : answer === "both" ? "不能只看点估计的正负。" : "不能把证据不足当作没有变化。"}</b>
      A 的区间完全低于 0，支持下降；B 的区间包含 0，暂不能确定方向，但不等于证明没有变化。即使 A 支持下降，也不能仅凭回归就认定因果关系。
    </p>}
  </details>;
}

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
            <tr><th>步骤</th><th>指标家族</th><th>比较设定</th><th>方向判断</th><th>效应与单位</th><th>标称 95% 近似区间</th><th>写作边界</th></tr>
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
