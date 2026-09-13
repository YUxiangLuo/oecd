import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./a11y";
import { LogoMark } from "./brand";
import type { ClassroomReport } from "./types";
import "./report-finish.css";

export function ReportOutro({ report, onClose, onExport, exportDisabled = false }: {
  report: ClassroomReport;
  onClose: () => void;
  onExport: () => void;
  exportDisabled?: boolean;
}) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useDialogFocus({ containerRef, initialFocusRef: headingRef, onClose });
  return createPortal(<div ref={containerRef} className="intro-overlay report-outro" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <div className="intro-scene">
      <div className="intro-logo"><LogoMark size={64} /></div>
      <span className="intro-scene-kicker">GVC SIMULATION LAB · 实验回顾</span>
      <h1 id={titleId} ref={headingRef} tabIndex={-1} className="intro-title">{report.state === "graded" ? "你的报告已获评阅" : "报告已提交，感谢你的探索"}</h1>
      <p className="intro-lede">从一张投入产出表出发，你把数据、图表与回归练习连接成了自己的分析。<br />感谢你认真记录证据，也认真对待结论的边界。</p>
      <section className="outro-receipt" aria-label="报告提交回执">
        <b>{report.state === "graded" ? `已评阅 · ${report.score ?? "—"} 分` : "提交成功 · 等待教师评阅"}</b>
        <span>提交时间：{report.submitted_at ? new Date(report.submitted_at).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        {report.state === "graded" && report.feedback && <p>教师评语：{report.feedback}</p>}
        <small>报告已保存到服务器。你可以离开页面，之后回到第15步查看报告与教师反馈。</small>
      </section>
      <div className="outro-journey">
        <article><span>01</span><b>读懂数据</b><p>从ICIO账户理解生产联系与价值来源。</p></article>
        <article><span>02</span><b>比较与验证</b><p>用时间趋势和国家比较组织图表证据。</p></article>
        <article><span>03</span><b>解释与反思</b><p>阅读模拟回归，说明不确定性与局限。</p></article>
      </div>
      <p className="intro-note">教学模拟帮助练习方法，不代表真实关税的政策效果。实验结束，保持追问。</p>
      <div className="intro-cta-row">
        <button type="button" className="intro-cta" onClick={onClose}>查看已提交报告</button>
        <button type="button" className="outro-export" disabled={exportDisabled} onClick={onExport}>导出 PDF 留存</button>
      </div>
      {exportDisabled && <p className="intro-note">实验记录有新修改，请返回第15步更新报告后再导出。</p>}
    </div>
  </div>, document.body);
}
