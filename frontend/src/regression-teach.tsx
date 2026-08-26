import {
  FAMILY_STEPS,
  familyDirectionLabel,
  nextRegressionFamily,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
  reportTakeaway,
  type ReadingDirection,
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

export function familyVerdict(
  outcome: RegressionOutcome,
  history: FamilyHistory,
  getStep?: (step: number) => SiblingStepData | undefined,
) {
  const data = getStep?.(FAMILY_STEPS[outcome]);
  const qualified = verdictFromSaved(outcome, data?.qualified_run);
  if (qualified) return qualified;
  const snapshot = history[outcome]?.[0];
  if (snapshot) return buildRegressionVerdict(outcome, snapshot.response);
  return verdictFromSaved(outcome, data?.run);
}

export function FamilyMap({
  current,
  history,
  getStep,
  onNavigateStep,
}: {
  current: RegressionOutcome;
  history: FamilyHistory;
  getStep?: (step: number) => SiblingStepData | undefined;
  onNavigateStep?: (step: number) => void;
}) {
  return (
    <section className="reg-family-map" aria-label="同一问题下的四类指标">
      <div className="reg-family-map-head">
        <span className="reg-section-step">四步同一句话</span>
        <p>壁垒出现后，这一组指标相对未受冲击的对象发生了怎样的变化？每步只换一类指标。</p>
      </div>
      <ol className="reg-family-track">
        {REGRESSION_FAMILIES.map((item) => {
          const verdict = familyVerdict(item.outcome, history, getStep);
          const currentStep = item.outcome === current;
          const direction = verdict ? familyDirectionLabel(verdict.state) : null;
          const status = currentStep ? (direction ? `当前 · ${direction}` : "当前") : (direction ?? "未估计");
          return (
            <li key={item.outcome} className={`reg-family-item${currentStep ? " current" : ""}${verdict ? " has-run" : ""}`}>
              <button
                type="button"
                className="reg-family-btn"
                aria-current={currentStep ? "step" : undefined}
                onClick={() => onNavigateStep?.(item.step)}
                disabled={!onNavigateStep}
              >
                <span className="reg-family-step">步骤 {item.step}</span>
                <b>{item.family}</b>
                <span className="reg-family-measure">{item.measure}</span>
                <span className="reg-family-status">{status}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function DidFourCells({ numeric }: { numeric?: boolean }) {
  if (numeric) {
    return (
      <div className="did-example">
        <table className="did-table did-table-numeric" aria-label="统一处理时点的 DID 四格直觉示意；实际主结果按 cohort 分别计算">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">组别</span></th>
              <th scope="col">冲击前</th>
              <th scope="col">冲击后</th>
              <th scope="col">自己变了多少</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">处理组</th>
              <td>18%</td>
              <td>16%</td>
              <td>−2 个百分点</td>
            </tr>
            <tr>
              <th scope="row">对照组</th>
              <td>12%</td>
              <td>13%</td>
              <td>+1 个百分点</td>
            </tr>
          </tbody>
        </table>
        <div className="did-formula">相对变化 =（−2）−（+1）= −3 个百分点</div>
        <p className="muted">
          这组数字只用来讲清四格，不是本步估计结果。处理组自己降了 2 个百分点，对照组自己升了 1 个百分点，相对变化是 −3 个百分点，不是 −2。
        </p>
      </div>
    );
  }
  return (
    <div className="did-comparison">
      <table className="did-table" aria-label="双重差分四格比较">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">组别</span></th>
            <th scope="col">冲击前</th>
            <th scope="col">冲击后</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">处理组</th>
            <td>A</td>
            <td>B</td>
          </tr>
          <tr>
            <th scope="row">对照组</th>
            <td>C</td>
            <td>D</td>
          </tr>
        </tbody>
      </table>
      <div className="did-formula">相对变化 =（B−A）−（D−C）</div>
      <p className="muted">和步骤 12 同一套比较。真实估计里，不同对象首次受冲击的年份可以不同。</p>
    </div>
  );
}

export function ReadingCoach({
  outcome,
  direction,
  effect,
  evidence,
  interpretation,
  onNavigateStep,
}: {
  outcome: RegressionOutcome;
  direction: ReadingDirection;
  effect: string;
  evidence: string;
  interpretation: string;
  onNavigateStep?: (step: number) => void;
}) {
  const lesson = REGRESSION_LESSONS[outcome];
  const next = nextRegressionFamily(outcome);
  return (
    <section className="reg-guide-card">
      <span className="reg-section-step">老师带读 · 按你这次结果</span>
      <ol className="reg-reading-list">
        <li>
          <b>先看区间。</b>
          {evidence}
        </li>
        <li>
          <b>再用本步指标说一遍。</b>
          {interpretation}
        </li>
        <li>
          <b>能写进报告的一句话。</b>
          {reportTakeaway(outcome, direction, effect)} {lesson.dontClaim}
        </li>
      </ol>
      <p className="reg-next-move">
        {next
          ? <>下一类指标是步骤 {next.step} 的{next.family}（{next.measure}）。比较方式不用换。</>
          : <>四步已经齐了。到第 16 步把方向和「看不出」并排写进原创分析，不要比系数大小。</>}
        {onNavigateStep && (
          <button type="button" className="gate-link" onClick={() => onNavigateStep(next ? next.step : 16)}>
            {next ? `去步骤 ${next.step}` : "去写报告"}
          </button>
        )}
      </p>
    </section>
  );
}

export function SiblingContrast({
  current,
  history,
  getStep,
}: {
  current: RegressionOutcome;
  history: FamilyHistory;
  getStep?: (step: number) => SiblingStepData | undefined;
}) {
  const prior = REGRESSION_FAMILIES.filter((item) => item.outcome !== current)
    .map((item) => {
      const verdict = familyVerdict(item.outcome, history, getStep);
      return verdict ? { ...item, label: familyDirectionLabel(verdict.state) } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item != null);
  if (prior.length === 0) return null;
  return (
    <p className="reg-sibling-contrast">
      前面已经记下：
      {prior.map((item) => `步骤 ${item.step} ${item.family}「${item.label}」`).join("；")}
      。本步再记一笔方向，不要和它们比系数大小。
    </p>
  );
}
