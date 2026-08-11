import { useEffect, useState } from "react";
import { api } from "../../api";
import { ReportMarkdown, preloadReportRenderer } from "../../report-renderer-lazy";
import { showToast } from "../../toast";
import type { GeneratedReport, MySubmission, ReportGateItem } from "../../types";
import type { SessionStatus } from "../../use-session";
import { useAsync } from "../shared";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

/** 报告生成必须等初次会话恢复和所有本地写入都由服务端确认。 */
export function reportGenerationReady(
  sessionStatus: SessionStatus,
  blocked: ReportGateItem[] | null,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
): boolean {
  return sessionStatus === "ready"
    && blocked != null
    && blocked.length === 0
    && !sessionUnsynced
    && !sessionSyncing;
}

export function submissionToastMessage(
  previous: MySubmission["state"],
  returned: "pending" | "graded",
): string {
  if (returned === "graded") return "报告已评阅";
  if (previous === "none") return "报告已提交，等待教师评阅";
  if (previous === "graded") return "已重新提交，等待教师重新评阅";
  return "报告已提交，仍在等待教师评阅";
}

/** 第 16 步:实验报告。
 *
 * 这一步刻意**没有任何参数表单**。报告由服务端从学生自己的实验会话生成:
 * 前 15 步答题通过后即可生成；自动保存的实验快照会进入报告，只有学生实际
 * 运行过的回归直接从会话保存结果写入报告。
 */

function GateCard({ blocked, onNavigateStep }: {
  blocked: ReportGateItem[];
  onNavigateStep: (step: number) => void;
}) {
  return (
    <section className="report-gate-panel">
      <div className="report-gate-head">
        <span className="report-gate-badge">!</span>
        <b>还不能生成报告：前 15 步的理解检查尚未全部通过</b>
      </div>
      <p className="muted">请完成以下步骤的选择题：</p>
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
    api.classroom
      .submitReport({ title: `实验报告 · ${report.provenance.session_fingerprint}` })
      .then(
        (submitted) => {
          setSubmitting(false);
          setSubmitError(null);
          showToast(submissionToastMessage(state, submitted.state));
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

export function ReportLab({
  completionKey,
  sessionStatus,
  sessionUnsynced,
  sessionSyncing,
  sessionSyncError,
  onFlushSession,
  onNavigateStep,
  onGenerated,
}: {
  completionKey: string;
  sessionStatus: SessionStatus;
  sessionUnsynced: boolean;
  sessionSyncing: boolean;
  sessionSyncError: string | null;
  onFlushSession: () => Promise<void>;
  onNavigateStep: (step: number) => void;
  /** 报告生成后通知外层重取服务端完成度。 */
  onGenerated: () => void;
}) {
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [blocked, setBlocked] = useState<ReportGateItem[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererSettled, setRendererSettled] = useState(false);
  const [submitRefresh, setSubmitRefresh] = useState(0);
  const mineQuery = useAsync<MySubmission>(() => api.classroom.myReport(), [submitRefresh]);
  const generatedQuery = useAsync<Partial<GeneratedReport>>(() => api.classroom.generatedReport(), []);
  const mine = mineQuery.data;

  useEffect(() => {
    let live = true;
    preloadReportRenderer().then(
      () => {
        if (!live) return;
        setRendererReady(true);
        setRendererSettled(true);
      },
      () => {
        if (live) setRendererSettled(true);
      },
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (generatedQuery.data?.markdown) setReport(generatedQuery.data as GeneratedReport);
  }, [generatedQuery.data]);

  useEffect(() => {
    setBlocked(null);
    if (sessionStatus !== "ready") return;
    let live = true;
    api.classroom.reportGate().then((gate) => {
      if (!live) return;
      setBlocked(gate.blocked);
    }, () => {});
    return () => { live = false; };
  }, [completionKey, sessionStatus]);

  // 进入报告页就冲刷防抖队列；同步成功前按钮保持锁定。失败由全局提示和
  // 下方重试入口共同呈现，不自动死循环重试。
  useEffect(() => {
    if (sessionStatus !== "ready" || !sessionUnsynced || sessionSyncing || sessionSyncError) return;
    void onFlushSession().catch(() => {});
  }, [sessionStatus, sessionUnsynced, sessionSyncing, sessionSyncError, onFlushSession]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      // 报告生成前冲刷当前浏览器的防抖保存队列。
      await onFlushSession();
    } catch (cause) {
      setGenerating(false);
      setError(`最新实验记录尚未保存，不能生成报告：${String((cause as Error).message ?? cause)}`);
      return;
    }
    try {
      const row = await api.classroom.generateReport();
      setReport(row);
      setBlocked([]);
      onGenerated();
    } catch (cause) {
      const apiError = cause as Error & { blocked?: ReportGateItem[] };
      // 门槛未过:服务端会告诉学生还差什么,原样展示,不在前端另编一套判断。
      if (apiError.blocked) setBlocked(apiError.blocked);
      else setError(apiError.message);
    } finally {
      setGenerating(false);
    }
  };

  const canGenerate = reportGenerationReady(sessionStatus, blocked, sessionUnsynced, sessionSyncing);
  const restoringReport = generatedQuery.status === "loading"
    || (mineQuery.status === "loading" && submitRefresh === 0)
    || !rendererSettled;

  return (
    <div className="report-lab">
      {blocked != null && blocked.length > 0 && <GateCard blocked={blocked} onNavigateStep={onNavigateStep} />}

      {sessionStatus !== "ready" && (
        <div className={sessionStatus === "unavailable" ? "error-box" : "muted"} role="status">
          {sessionStatus === "loading"
            ? "正在恢复最新实验记录，恢复完成后才能生成报告…"
            : "当前无法连接教学服务，不能确认最新实验记录或生成报告。"}
        </div>
      )}

      {sessionUnsynced && (
        <div className={sessionSyncError ? "error-box" : "muted"} role="status">
          {sessionSyncError
            ? "最新实验记录尚未保存；保存成功后才能生成报告。"
            : "正在保存最新实验记录，完成后即可生成报告…"}
          {sessionSyncError && (
            <button
              type="button"
              className="secondary"
              disabled={sessionSyncing}
              onClick={() => { void onFlushSession().catch(() => {}); }}
            >
              {sessionSyncing ? "正在重试…" : "重试保存"}
            </button>
          )}
        </div>
      )}

      <section className="report-actions">
        <button className="run-btn" onClick={() => { void generate(); }} disabled={generating || !canGenerate}>
          {sessionStatus === "loading"
            ? "正在恢复实验记录…"
            : sessionStatus === "unavailable"
              ? "教学服务不可用"
              : sessionUnsynced
            ? "等待最新记录保存…"
            : generating ? "服务端生成中…" : report ? "重新生成报告" : "生成实验报告"}
        </button>
        <button
          className="secondary"
          onClick={() => window.print()}
          disabled={!report || !rendererReady}
          title={rendererReady ? "打开浏览器打印对话框,选择“另存为 PDF”即可保存" : "报告渲染器加载中…"}
        >
          打印 / 另存为 PDF
        </button>
        <span className="muted report-provenance-slot" aria-live="polite">
          {report && (
            <>
            会话摘要 <code>{report.provenance.session_fingerprint}</code> · 数据年份 {report.provenance.years.join("、")}
            {report.suggested_filename && <> · 建议文件名 <code>{report.suggested_filename}</code></>}
            </>
          )}
        </span>
      </section>

      {error && <div className="error-box">{error}</div>}
      {generatedQuery.status === "error" && (
        <div className="error-box async-error" role="alert">
          <span>恢复已生成报告失败：{generatedQuery.error}</span>
          <button type="button" className="secondary" onClick={generatedQuery.retry}>重试</button>
        </div>
      )}
      {mineQuery.status === "error" && (
        <div className="error-box async-error" role="alert">
          <span>恢复提交与评分状态失败：{mineQuery.error}</span>
          <button type="button" className="secondary" onClick={mineQuery.retry}>重试</button>
        </div>
      )}

      {restoringReport ? (
        <div className="report-restore-skeleton" role="region" aria-busy="true" aria-label="正在恢复报告">
          <span className="skeleton-block skeleton-line wide" />
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-report" />
          <span className="sr-only" role="status">正在恢复已生成报告和评阅状态…</span>
        </div>
      ) : report ? (
        <>
          <SubmitCard report={report} mine={mine ?? null} onSubmitted={() => setSubmitRefresh((n) => n + 1)} />
          <div className="report-body">
            <ReportMarkdown markdown={report.markdown} />
          </div>
        </>
      ) : (
        canGenerate && <p className="muted">前 15 步均已答题通过。点击上方按钮生成报告；没有实际运行过的回归会如实标记为“未记录”。</p>
      )}
    </div>
  );
}
