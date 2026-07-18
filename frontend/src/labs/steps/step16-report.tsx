import { useEffect, useState } from "react";
import { api } from "../../api";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { showToast } from "../../toast";
import type { GeneratedReport, MySubmission, ReportGateItem } from "../../types";
import { useAsync } from "../shared";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

/** 第 16 步:实验报告。
 *
 * 这一步刻意**没有任何参数表单**。报告由服务端从学生自己的实验会话生成:
 * 前 15 步证据齐全才允许生成,回归在服务端按学生保存的设定重跑,正文与溯源
 * 一起落库。界面只负责触发、展示和提交 report_key——它拿不到、也不需要
 * 任何可以自己编造的内容。
 */

function GateCard({ blocked, onNavigateStep }: {
  blocked: ReportGateItem[];
  onNavigateStep: (step: number) => void;
}) {
  return (
    <section className="evidence-panel">
      <div className="evidence-head">
        <span className="evidence-badge">!</span>
        <b>还不能生成报告:前 15 步的学习证据尚未齐全</b>
      </div>
      <p className="muted">报告要能证明你做过这门课,因此它只从你自己的实验记录生成。还差:</p>
      <ul>
        {blocked.map((item) => (
          <li key={item.step}>
            {item.step > 0 ? (
              <button type="button" className="gate-link" onClick={() => onNavigateStep(item.step)}>
                步骤 {item.step} · {item.title}
              </button>
            ) : (
              <b>{item.title}</b>
            )}
            {" — "}
            {item.missing.join(";")}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubmitCard({ report, mine, onSubmitted }: {
  report: GeneratedReport;
  mine: MySubmission | null;
  onSubmitted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const state = mine?.state ?? "none";

  const submit = () => {
    setSubmitting(true);
    // 只交报告指纹:正文由服务端从它自己生成的那份取,接口不收 Markdown。
    api.classroom
      .submitReport({ title: `实验报告 · ${report.report_key}`, report_key: report.report_key })
      .then(
        () => {
          setSubmitting(false);
          setSubmitError(null);
          showToast(state === "none" ? "报告已提交，等待教师评阅" : "已重新提交，等待教师重新评阅");
          onSubmitted();
        },
        (e: Error) => {
          setSubmitting(false);
          setSubmitError(e.message);
        },
      );
  };

  return (
    <section className="submit-card">
      <div className="submit-row">
        <button className="primary" onClick={submit} disabled={submitting}>
          {submitting ? "提交中…" : state === "none" ? "提交报告给老师" : "重新提交"}
        </button>
        {state !== "none" && (
          <span className="muted">
            上次提交 {fmtTime(mine?.submitted_at)} ·{" "}
            {state === "graded" ? `已评阅 ${mine?.score} 分` : "等待评阅"}
          </span>
        )}
      </div>
      {state === "graded" && mine?.feedback && <p className="muted">教师评语:{mine.feedback}</p>}
      {submitError && <div className="error-box">{submitError}</div>}
    </section>
  );
}

export function ReportLab({ onNavigateStep, onGenerated }: {
  onNavigateStep: (step: number) => void;
  /** 报告生成后服务端会写入第 16 步证据,通知外层重取完成度。 */
  onGenerated: () => void;
}) {
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [blocked, setBlocked] = useState<ReportGateItem[] | null>(null);
  const [halted, setHalted] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [submitRefresh, setSubmitRefresh] = useState(0);
  const { data: mine } = useAsync<MySubmission>(() => api.classroom.myReport(), [submitRefresh]);

  useEffect(() => {
    let live = true;
    preloadReportRenderer().then(() => live && setRendererReady(true), () => {});
    // 进入本步先取回上次生成的报告:刷新或换设备后仍能直接读到全文。
    api.classroom.generatedReport().then(
      (row) => { if (live && row.report_key) setReport(row as GeneratedReport); },
      () => {},
    );
    api.classroom.reportGate().then((gate) => {
      if (!live) return;
      setBlocked(gate.blocked);
      setHalted(gate.halted === true);
    }, () => {});
    return () => { live = false; };
  }, []);

  const generate = () => {
    setGenerating(true);
    setError(null);
    api.classroom.generateReport().then(
      (row) => {
        setGenerating(false);
        setReport(row);
        setBlocked([]);
        onGenerated();
      },
      (e: Error & { blocked?: ReportGateItem[] }) => {
        setGenerating(false);
        // 门槛未过:服务端会告诉学生还差什么,原样展示,不在前端另编一套判断。
        if (e.blocked) setBlocked(e.blocked);
        else setError(e.message);
      },
    );
  };

  const canGenerate = !halted && blocked != null && blocked.length === 0;

  return (
    <div>
      {halted && <div className="warnbox">你在步骤 2 选择了“停止分析”。这份质检决策已记录，但报告保持锁定；请返回步骤 2 修改处置，或等待新数据通过复检。</div>}
      {blocked != null && blocked.length > 0 && <GateCard blocked={blocked} onNavigateStep={onNavigateStep} />}

      <section className="report-actions">
        <button className="run-btn" onClick={generate} disabled={generating || !canGenerate}>
          {generating ? "服务端生成中…" : report ? "重新生成报告" : "生成实验报告"}
        </button>
        <button
          className="secondary"
          onClick={() => window.print()}
          disabled={!report || !rendererReady}
          title={rendererReady ? "打开浏览器打印对话框,选择“另存为 PDF”即可保存" : "报告渲染器加载中…"}
        >
          打印 / 另存为 PDF
        </button>
        {report && (
          <span className="muted">
            指纹 <code>{report.report_key}</code> · 产物 <code>{report.provenance.manifest_id}</code> · 会话 rev{" "}
            {report.provenance.session_revision}
            {report.suggested_filename && <> · 建议文件名 <code>{report.suggested_filename}</code></>}
          </span>
        )}
      </section>

      {error && <div className="error-box">{error}</div>}

      {report ? (
        <>
          <SubmitCard report={report} mine={mine ?? null} onSubmitted={() => setSubmitRefresh((n) => n + 1)} />
          <div className="report-body">
            <ReportMarkdown markdown={report.markdown} />
          </div>
        </>
      ) : (
        canGenerate && <p className="muted">前 15 步的证据已齐全,点击上方按钮由服务端生成报告。</p>
      )}
    </div>
  );
}
