import { displayBaselineLabel, familyDirectionLabel, lessonFor, REGRESSION_FAMILIES } from "./regression-lessons";
import { BAR_UNIT_TITLES, depvarKind, SD_DEFINITION, standardizedDigits, standardizedEffect } from "./regression-verdict";
import { api } from "./api";
import { useAsync } from "./labs/shared";
import { decompositionParts, familyRun, familyVerdict, lagParts, regressionSummaryRows, type SiblingStepData } from "./regression-teach-logic";
import { experimentLabel, omittedSummary, perPointDigits, perPointReading, snapshotOf, specSummary, xSpanLabel, xSum, type PerPointSource } from "./regression-workbench-table";
import type { FirstWaveDecomposition, RegressionOutcome, TeachingOverviewResponse, WorkbenchOptions } from "./types";
import { DivergingBarChart } from "./viz/regression/diverging-bars";


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
            <tr><th scope="col">步骤</th><th scope="col">指标类型</th><th scope="col">方向</th><th scope="col">X 每高 1 个百分点，Y 两年累计平均相差</th><th scope="col">其中当年 / 次年</th><th scope="col">95% 区间</th><th scope="col">解释限制</th></tr>
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
                  <td><b>{verdict?.effectBrief ?? "—"}</b>{shareSize(item.outcome, verdict, familyRun(item.outcome, getStep))}</td>
                  <td>{lagParts(item.outcome, familyRun(item.outcome, getStep))}</td>
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

/**
 * Step 15: the model experiment each of steps 11–14 put into the report, with its X-terms sum next to the step's
 * default model (the report's appendix recomputes both). Each links back to its step.
 */
export function ReportedExperiments({ getStep, onNavigateStep }: {
  getStep?: (step: number) => SiblingStepData | undefined;
  onNavigateStep?: (step: number) => void;
}) {
  const rows = REGRESSION_FAMILIES.flatMap((item) => {
    const experiment = getStep?.(item.step)?.experiment;
    return experiment ? [{ ...item, experiment, run: familyRun(item.outcome, getStep) }] : [];
  });
  const optionsQuery = useAsync<WorkbenchOptions>(() => api.regressionOptions(), ["regression-options"], { enabled: rows.length > 0 });
  const options = optionsQuery.status === "success" ? optionsQuery.data ?? null : null;
  // An experiment without a baseline was run on its step's saved (default) Y.
  const otherY = rows.some(({ experiment, run }) => !!experiment.baseline && experiment.baseline !== run?.design?.baseline);
  const overviewQuery = useAsync<TeachingOverviewResponse>(() => api.teachingOverview(), ["teaching-overview"], { enabled: otherY });
  const overview = overviewQuery.status === "success" ? overviewQuery.data : null;
  return (
    <section className="reg-reported-models" aria-labelledby="reg-reported-models-title">
      <span className="reg-section-step">改模型、对比</span>
      <h3 id="reg-reported-models-title">你的模型实验</h3>
      {rows.length === 0
        ? <p className="muted">还没有记入报告的模型实验（选做）：在步骤 11–14 的“改模型、对比”里算出一个模型，在“记入报告（选做）”框里记入，报告附录会把它和同一 Y 的默认模型并列。</p>
        : (
          <div className="table-wrap" role="region" aria-label="记入报告的模型实验，可横向滚动" tabIndex={0}>
            <table className="data-table reg-reported-table">
              <thead><tr><th scope="col">步骤</th><th scope="col">改动</th><th scope="col">设定</th><th scope="col">X 各项合计（X 每高 1 个百分点）</th><th scope="col">同一 Y 的默认模型（两年累计）</th></tr></thead>
              <tbody>
                {rows.map(({ step, family, outcome, experiment, run }) => {
                  const sum = xSum(experiment.snapshot, experiment.spec);
                  const sameY = !experiment.baseline || experiment.baseline === run?.design?.baseline;
                  const stepDefault = sameY && run?.design && run.result ? snapshotOf({ design: run.design, result: run.result }) : null;
                  // The default model's sample is the same for every Y of the family (one panel, one model): the
                  // step's saved run gives it on another Y too.
                  const defaultSample = run?.design && run.result ? snapshotOf({ design: run.design, result: run.result }).result : null;
                  const estimate = !sameY ? overview?.outcomes[outcome]?.find((item) => item.key === experiment.baseline) : null;
                  const defaultSource: PerPointSource | null = stepDefault ?? (estimate ? {
                    depvar_kind: estimate.kind,
                    result: { suppressed: estimate.suppress_inference || !(estimate.status === "ok" || estimate.status === "warning") },
                  } : null);
                  const defaultSum = stepDefault?.result.cumulative ?? (estimate?.coef != null
                    ? { coef: estimate.coef, ci_low: estimate.ci_low, ci_high: estimate.ci_high } : null);
                  // Both numbers at the default's decimals, so the two read alike.
                  const digits = defaultSum && defaultSource ? perPointDigits(outcome, defaultSum, defaultSource) : undefined;
                  return (
                    <tr key={step}>
                      <th scope="row">
                        {onNavigateStep
                          ? <button type="button" className="link-button" onClick={() => onNavigateStep(step)}>步骤 {step} · {family}</button>
                          : `步骤 ${step} · ${family}`}
                      </th>
                      <td><b>{options ? experimentLabel(experiment.spec, options) : "…"}</b><br /><small className="muted">Y：{displayBaselineLabel(experiment.snapshot.depvar_label)}</small></td>
                      <td>{options ? <>
                        {specSummary(experiment.spec, options)}
                        {omittedSummary(experiment.snapshot, options).map((text) => <p className="muted" key={text}>{text}</p>)}
                      </> : "…"}</td>
                      <td>
                        {sum ? `${perPointReading(outcome, sum, experiment.snapshot, digits)}（${xSpanLabel(experiment.spec)}）` : "—"}
                        {/* The writing prompt asks whether the samples are the same: each number names its sample. */}
                        <br /><small className="muted">{sampleText(experiment.snapshot.result)}{defaultSample && sampleText(defaultSample) !== sampleText(experiment.snapshot.result) ? "（与默认模型不同）" : ""}</small>
                      </td>
                      <td>
                        {defaultSum && defaultSource ? perPointReading(outcome, defaultSum, defaultSource, digits) : !sameY && overviewQuery.status === "loading" ? "…" : "—"}
                        {defaultSample && <><br /><small className="muted">{sampleText(defaultSample)}</small></>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}


/**
 * A share Y's size in standard deviations ("（幅度约 0.37 个标准差）"), which the table's note promises in brackets
 * and steps 13–14 carry in their reading already; empty otherwise.
 */
function shareSize(
  outcome: RegressionOutcome,
  verdict: ReturnType<typeof familyVerdict>,
  run: ReturnType<typeof familyRun>,
): string {
  if (!verdict?.coefficient || !run?.design || depvarKind(outcome, run.design) !== "share" || verdict.state === "suppressed") return "";
  const sd = standardizedEffect(verdict.coefficient.coef, run.result?.depvar_within_std);
  return sd == null ? "" : `（幅度约 ${(Math.abs(sd) < 0.0005 ? "不到 0.001" : Math.abs(sd).toFixed(standardizedDigits(sd, null)))} 个标准差）`;
}

/** "样本 N = 12,800，2017–2020": a model's sample, as the workbench table gives it. */
function sampleText(result: { n_obs: number; years: [number, number] | null }): string {
  return `样本 N = ${result.n_obs.toLocaleString("zh-CN")}${result.years ? `，${result.years.join("–")}` : ""}`;
}

export function DecompositionList(props: { decomposition: FirstWaveDecomposition; metric: string; scale: number; unit: string; digits: number }) {
  const { lead, parts, tail } = decompositionParts(props.decomposition, props.metric, props.scale, props.unit, props.digits);
  return (
    <div className="reg-decomposition" role="note">
      <p>{lead}</p>
      <ul>
        {parts.map((part) => <li key={part.label} className={part.tariff ? "reg-decomposition-tariff" : undefined}>
          {part.tariff ? <b>{part.label} {part.value}</b> : <>{part.label} {part.value}</>}
        </li>)}
      </ul>
      <p className="muted">{tail}</p>
    </div>
  );
}
