import {
  FAMILY_STEPS,
  familyDirectionLabel,
  REGRESSION_FAMILIES,
  REGRESSION_LESSONS,
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

export type RegressionReadingAnswer = "positive" | "negative" | "insufficient" | "blocked";

export interface RegressionReadingCheckState {
  run_identity: string;
  answer: RegressionReadingAnswer;
}

export function readingAnswerForDirection(direction: ReadingDirection): RegressionReadingAnswer {
  if (direction === "positive" || direction === "negative") return direction;
  if (direction === "insufficient") return "insufficient";
  return "blocked";
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
      <p className="muted">四格仅用于理解双重差分；跨步骤并读前，请核对各步实际保存的比较方法与设定。真实估计里，不同对象首次受冲击的年份可以不同。</p>
    </div>
  );
}

const READING_OPTIONS: Array<{
  value: RegressionReadingAnswer;
  label: string;
  explanation: string;
}> = [
  { value: "positive", label: "相对上升", explanation: "点估计为正，且区间没有跨过 0" },
  { value: "negative", label: "相对下降", explanation: "点估计为负，且区间没有跨过 0" },
  { value: "insufficient", label: "目前看不出方向", explanation: "区间跨过 0；这不等于没有效应" },
  { value: "blocked", label: "当前不能判断", explanation: "支持度或诊断不允许作方向推断" },
];

export function RegressionReadingCheck({
  answer,
  expected,
  stale = false,
  onAnswer,
}: {
  answer?: RegressionReadingAnswer;
  expected: RegressionReadingAnswer;
  stale?: boolean;
  onAnswer: (answer: RegressionReadingAnswer) => void;
}) {
  const correct = answer === expected;
  const feedback = answer == null
    ? null
    : correct
      ? "判断正确。请对照上方结果说明，检查自己的理由。"
      : expected === "blocked"
        ? "再看一次支持度和冲击前诊断：只要推断条件检查没有通过，就不能用点估计判断升降。"
        : expected === "insufficient"
          ? "再看一次 95% 置信区间是否跨过 0。跨过 0 时应保留“不确定”。"
          : "再同时检查区间是否跨过 0，以及点估计前面的正负号。";
  return (
    <section className={`reg-reading-check${correct ? " correct" : answer ? " retry" : ""}`} aria-labelledby="reg-reading-check-title">
      <div className="reg-reading-check-head">
        <div>
          <span className="reg-section-step">练习 · 再判断一次</span>
          <h3 id="reg-reading-check-title">先看结果状态，再看估计与区间：这次结果该怎么说？</h3>
        </div>
        <span className="reg-formative-badge">练习 · 不影响完成状态</span>
      </div>
      {stale && <p className="stale-result">这是修改设定前的结果；你的判断仍会绑定到这一次运行。</p>}
      <div className="reg-reading-options" role="group" aria-label="选择本次回归结果的方向判断">
        {READING_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={answer === option.value ? "selected" : ""}
            aria-pressed={answer === option.value}
            onClick={() => onAnswer(option.value)}
          >
            <b>{option.label}</b>
            <span>{option.explanation}</span>
          </button>
        ))}
      </div>
      {feedback && (
        <p className="reg-reading-feedback" role={correct ? "status" : "alert"}>
          <b>{correct ? "正确" : "再试一次"}</b>{feedback}
        </p>
      )}
    </section>
  );
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
                    {design.shock_type_label || design.shock_type}
                    <span>{design.method_label || design.method}</span>
                    <span>{design.granularity_label || design.granularity} · {design.scenario_label || design.scenario}</span>
                    <span>{design.weight_mode === "contemporaneous" ? "当期权重" : "固定处理前权重"}</span>
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
