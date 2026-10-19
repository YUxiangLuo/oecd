import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { LogoMark } from "./brand";
import type { ClassroomReport, ReportReviewEstimate } from "./types";
import "./intro.css";
import "./report-finish.css";

const DIMENSIONS: Record<string, string> = { trade: "贸易", production: "生产", length: "长度", network: "网络" };
const fmtTime = (value: string | null) => value ? value.slice(0, 16).replace("T", " ") : "—";
const yearText = (years: number[], endpoints = false) => {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (!sorted.length) return "年份未记录";
  if (sorted.length === 1) return String(sorted[0]);
  // Regression sample_flow records the endpoints; observed materials record every saved year.
  return endpoints || sorted.every((year, index) => index === 0 || year === sorted[index - 1] + 1)
    ? `${sorted[0]}–${sorted.at(-1)}` : sorted.join("、");
};

function Estimate({ result }: { result: ReportReviewEstimate }) {
  return <div className="outro-estimate" data-inference={result.inference}>
    <p className="outro-estimate-span">{result.x_span}</p>
    <div className="outro-value"><strong>{result.value_text}</strong><span>{result.unit}</span></div>
    <p className="outro-interval">95% 置信区间：{result.interval_text}</p>
    <p className="outro-inference">{result.inference_note}</p>
    <small>有效样本量 N = {result.n_obs?.toLocaleString("zh-CN") ?? "—"} · {yearText(result.years, true)}</small>
  </div>;
}

export function ReportOutro({ report, onClose, onExport, onViewReport, onReturnStep, exportDisabled = false, reportOutdated = false }: {
  report: ClassroomReport;
  onClose: () => void;
  onExport: () => void;
  onViewReport?: () => void;
  onReturnStep?: (step: number) => void;
  exportDisabled?: boolean;
  reportOutdated?: boolean;
}) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useDialogFocus({ containerRef, initialFocusRef: headingRef, onClose });
  const review = report.provenance.review;
  const graded = report.state === "graded";
  const draft = report.state === "draft";
  const returnLink = (step: number) => onReturnStep && <button type="button" className="outro-step-link" onClick={() => onReturnStep(step)}>返回步骤 {step} →</button>;
  return createPortal(<div ref={containerRef} className="intro-overlay report-outro" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header className="intro-header"><div className="intro-brand"><LogoMark size={32} /><span>供应链仿真系统</span></div><span className="intro-header-label">实验总结</span><button type="button" className="intro-skip" aria-label="关闭回执" onClick={onClose}>关闭 <span aria-hidden="true">×</span></button></header>
    <div className="intro-content"><main className="outro-page">
      <p className="intro-eyebrow">报告提交与评阅</p>
      <h1 id={titleId} ref={headingRef} tabIndex={-1} className="intro-title">{draft ? "报告草稿 · 尚未提交" : graded ? "报告已评阅" : "报告已提交"}</h1>
      <section className="outro-receipt" aria-label="报告提交回执">
        {reportOutdated && <div role="status" className="outro-receipt-caveat">
          <b>报告需更新</b><p>当前实验记录包含尚未纳入报告的修改。以下内容对应已保存的报告版本；后续修改须在步骤 15 保存并更新报告。</p>
          {graded && <p>重新生成将替换已评阅报告、清除评分与评语，并重新提交评阅。该操作须经确认；取消后保留原报告。已评阅版本可先导出 PDF 留存。</p>}
          {returnLink(15)}
        </div>}
        <div className="outro-receipt-status"><b>{draft ? "草稿状态 · 尚未提交评阅" : graded ? `已评阅 · ${report.score ?? "—"} 分` : reportOutdated ? "已提交版本 · 等待教师评阅" : "已提交 · 等待教师评阅"}</b><span>{draft ? "生成时间" : "提交时间"}：{fmtTime(draft ? report.generated_at : report.submitted_at)}{graded && ` · 评阅时间：${fmtTime(report.graded_at)}`}</span></div>
        {graded && report.feedback?.trim() && <div className="outro-feedback" tabIndex={0} role="region" aria-label="教师评语"><b>教师评语</b><p>{report.feedback}</p></div>}
        {!reportOutdated && <small>{draft ? "草稿生成与 PDF 导出不替代报告提交。" : "报告已保存，可在步骤 15 查看报告及评阅结果。"}</small>}
      </section>
      <section className="outro-section" aria-labelledby={`${titleId}-question`}>
        <div className="outro-section-heading"><h2 id={`${titleId}-question`}>研究问题</h2>{returnLink(15)}</div>
        <p className="outro-prose">{review.research_question || "未填写研究问题。"}</p>
      </section>
      <section className="outro-section" aria-labelledby={`${titleId}-evidence`}>
        <div className="outro-section-heading"><h2 id={`${titleId}-evidence`}>图表材料与观察范围</h2><span>经济体 · 行业 · 年份</span></div>
        <div className="outro-evidence">{review.evidence.map(material => <article key={material.step}>
          <div><span className="outro-step">步骤 {material.step}</span><h3>{material.title}</h3>{returnLink(material.step)}</div>
          <div><p>{material.countries.join("、")} · {material.industry_scope} · {yearText(material.years)}</p><ul>{material.chart_titles.map(title => <li key={title}>{title}</li>)}</ul>{material.industries.length > 1 && <p className="outro-industries">行业：{material.industries.join("、")}</p>}</div>
        </article>)}</div>
        {!review.evidence.length && <p className="outro-empty">报告未包含图表材料。</p>}
      </section>
      <section className="outro-section" aria-labelledby={`${titleId}-results`}>
        <div className="outro-section-heading"><h2 id={`${titleId}-results`}>四项默认模型估计结果</h2><span>教学模拟 · X 增加 1 个百分点</span></div>
        <p className="outro-section-note">主结果为当期 X 与滞后一期 L1_X 的系数之和。在其他条件相同且 X 持续提高 1 个百分点时，该合计值表示第二年及以后 Y 的条件差异，而非两年 Y 变化量之和。各 Y 单位不同，估计值不可直接比较；模拟结果不构成现实政策的因果证据。</p>
        <div className="outro-results">{review.results.map(result => <article key={result.step}>
          <span className="outro-step">步骤 {result.step} · {DIMENSIONS[result.outcome] ?? result.outcome}</span><h3>{result.y_label}</h3><Estimate result={result} />{returnLink(result.step)}
        </article>)}</div>
        {!review.results.length && <p className="outro-empty">报告未包含默认模型估计结果。</p>}
      </section>
      {review.custom_models.length > 0 && <section className="outro-section" aria-labelledby={`${titleId}-models`}>
        <div className="outro-section-heading"><h2 id={`${titleId}-models`}>自主模型比较</h2><span>已纳入报告：{review.custom_models.length} 项</span></div>
        <p className="outro-section-note">同一 Y 下对照默认模型与自主模型，数值均按 X 增加 1 个百分点换算。比较时须核对 X 项的时间跨度、置信区间及有效样本；不同跨度对应不同估计量。</p>
        <div className="outro-models">{review.custom_models.map(model => <article key={model.step}>
          <div className="outro-section-heading"><h3>步骤 {model.step} · {model.result.y_label}</h3>{returnLink(model.step)}</div>
          <p className="outro-model-name">{model.name}</p><p className="outro-specification">{model.specification}</p>
          <div className="outro-model-comparison"><div><h4>同一 Y 的默认模型</h4><Estimate result={model.reference} /></div><div><h4>已纳入报告的自主模型</h4><Estimate result={model.result} /></div></div>
        </article>)}</div>
      </section>}
      <section className="outro-section" aria-labelledby={`${titleId}-interpretation`}><div className="outro-section-heading"><h2 id={`${titleId}-interpretation`}>证据解释</h2>{returnLink(15)}</div><p className="outro-prose">{review.evidence_interpretation || "未填写证据解释。"}</p></section>
      <section className="outro-section" aria-labelledby={`${titleId}-limitations`}><div className="outro-section-heading"><h2 id={`${titleId}-limitations`}>研究局限与后续方向</h2>{returnLink(15)}</div><p className="outro-prose">{review.limitations || "未填写研究局限与后续方向。"}</p></section>
    </main></div>
    <footer className="outro-footer"><div><span>摘要与报告正文使用同一版本</span>{reportOutdated && !graded && <small>更新报告后可导出 PDF。</small>}</div><div><button type="button" className="outro-export" disabled={exportDisabled || (reportOutdated && !graded)} onClick={onExport}>导出 PDF 留存</button><button type="button" className="intro-cta" onClick={onViewReport ?? onClose}>查看完整报告</button></div></footer>
  </div>, document.body);
}
