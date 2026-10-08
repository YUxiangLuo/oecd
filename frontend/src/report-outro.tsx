import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { LogoMark } from "./brand";
import type { ClassroomReport } from "./types";
import "./report-finish.css";

export function ReportOutro({ report, onClose, onExport, exportDisabled = false, reportOutdated = false }: {
  report: ClassroomReport;
  onClose: () => void;
  onExport: () => void;
  exportDisabled?: boolean;
  reportOutdated?: boolean;
}) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useDialogFocus({ containerRef, initialFocusRef: headingRef, onClose });
  return createPortal(<div ref={containerRef} className="intro-overlay report-outro" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <button type="button" className="intro-skip" aria-label="关闭回执" title="关闭" onClick={onClose}><span aria-hidden="true">×</span></button>
    <div className="intro-scene">
      <div className="intro-logo"><LogoMark size={64} /></div>
      <span className="intro-scene-kicker">GVC SIMULATION LAB · 实验回顾</span>
      <h1 id={titleId} ref={headingRef} tabIndex={-1} className="intro-title">{report.state === "graded" ? "报告已评阅" : "报告已提交"}</h1>
      <p className="intro-lede">报告包含已保存的数据、图表、回归结果和你的分析。</p>
      <section className="outro-receipt" aria-label="报告提交回执">
        <b>{report.state === "graded" ? `已评阅 · ${report.score ?? "—"} 分` : "提交成功 · 等待教师评阅"}</b>
        <span>提交时间：{report.submitted_at ? report.submitted_at.slice(0, 16).replace("T", " ") : "—"}</span>
        {report.state === "graded" && report.feedback?.trim() && <p>教师评语：{report.feedback}</p>}
        {reportOutdated ? <div role="status">
          <p>已提交版本已保存；后续修改尚未纳入这份报告。请返回第 15 步确认修改已保存，再更新报告。</p>
          {report.state === "graded" && <p>重新生成会清除当前评分与评语，并重新提交给老师；操作前会要求确认。取消确认将保留原报告。</p>}
        </div> : <small>报告已保存到服务器。你可以离开页面，之后回到第 15 步查看报告与教师反馈。</small>}
      </section>
      <div className="outro-journey">
        <article><span>01</span><b>计算并理解指标</b><p>从 ICIO 账户理解生产联系与价值来源。</p></article>
        <article><span>02</span><b>看变化与全球位置</b><p>看指标的历年变化、在全部经济体中的位置，再与对比国家比较。</p></article>
        <article><span>03</span><b>汇总四项回归结果</b><p>解释 X 与 Y 的关系、不确定性和局限。</p></article>
      </div>
      <div className="intro-cta-row">
        <button type="button" className="intro-cta" onClick={onClose}>查看已提交报告</button>
        <button type="button" className="outro-export" disabled={exportDisabled || reportOutdated} onClick={onExport}>导出 PDF 留存</button>
      </div>
      {reportOutdated && <p className="intro-note">请核对上方版本提示，更新报告后再导出。</p>}
    </div>
  </div>, document.body);
}
