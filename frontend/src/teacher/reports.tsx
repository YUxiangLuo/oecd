import { normalizeLabel } from "./text";
import { useEffect, useId, useRef, useState } from "react";
import { ScrollableRegion } from "../a11y";
import { api, isApiErrorStatus } from "../api";
import { useAsync } from "../labs/shared";
import { ReportMarkdown } from "../report-renderer-lazy";
import { showToast } from "../toast";
import type { AcademicSemester, AuthUser, TeacherReport } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { AcademicFilters, matchesAcademicFilter, enrollmentLabel } from "./academic-filter";
import { EmptyState, LoadFailure, SearchInput, StatusPill, Toolbar, useModalErrorFocus, useRefetchOnVisible } from "./ui";
import { LEAVE_MESSAGE, useTeacherReviewGuard } from "./review-guard";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";
type Filter = "pending" | "graded" | "all";

/** Empty list copy: "no match" only when a search or class filter is active, not when all pending work is done. */
export function reportsEmptyState(total: number, filter: Filter, narrowed: boolean): { title: string; hint: string } {
  if (!total) return { title: "还没有学生提交报告", hint: "学生提交报告后会出现在这里" };
  if (narrowed) return { title: "没有匹配的报告", hint: "换个筛选或关键词试试" };
  if (filter === "pending") return { title: "暂无待评阅报告", hint: "已提交的报告都评阅完了；新的提交会出现在这里" };
  return { title: "暂无已评阅报告", hint: "评阅后的报告会出现在这里" };
}

export const REPORT_FILTER_LABELS: Record<Filter, string> = {
  pending: "待评阅",
  graded: "已评阅",
  all: "全部",
};

export function reportRowAction(report: Pick<TeacherReport, "state" | "display_name">): { visible: string; accessible: string } {
  if (report.state === "graded") {
    return { visible: "查看/改评", accessible: `查看/改评：${report.display_name}` };
  }
  return { visible: "评阅报告", accessible: `评阅报告：${report.display_name}` };
}

const GRADE_RUBRIC = [
  ["概念与衔接 · 25", "能说明数据→指标→可视化→处理变量→回归→报告的关系，术语使用准确。"],
  ["证据使用 · 25", "引用实际保存的比较、点估计和区间，数字与报告快照一致。"],
  ["识别与边界 · 25", "区分描述、相对变化和因果结论，主动说明拟真冲击、薄对照、外溢与同期冲击。"],
  ["表达与可复核性 · 25", "研究问题明确，结论、证据与局限相互对应，教师可沿报告记录复核。"],
] as const;

export const STALE_REVIEW_HINT = "这份报告在你打开后已被学生重新提交或由其他教师评阅。载入最新报告后，你已输入的分数和评语会保留，请核对报告内容后再保存。";
export const RELOADED_REVIEW_NOTE = "已载入最新报告，并保留了你输入的分数和评语；请核对报告内容后再保存。";

export function ReportRowAction({
  report,
  onOpen,
}: {
  report: Pick<TeacherReport, "state" | "display_name">;
  onOpen: () => void;
}) {
  const action = reportRowAction(report);
  return (
    <button type="button" className="primary sm" aria-label={action.accessible} onClick={onOpen}>
      {action.visible}
    </button>
  );
}

export function ReportsTab({ user, onGraded, onRefresh }: { user: AuthUser; onGraded?: () => void; onRefresh?: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const [openAccountId, setOpenAccountId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [query, setQuery] = useState("");
  const [semesterId, setSemesterId] = useState<number | null>(null);
  const [classId, setClassId] = useState<number | null>(null);
  // Counts completed list loads, so focus can wait for the list refreshed after a review.
  const [loads, setLoads] = useState(0);
  const { data, error, status, retry } = useAsync<{ reports: TeacherReport[] }>(
    () => api.classroom.reports().then((result) => {
      setLoads((value) => value + 1);
      return result;
    }),
    [refresh],
    { keepPreviousData: true },
  );
  const { data: academic, error: academicError, retry: retryAcademic } = useAsync(() => api.classroom.semesters(), [refresh], { keepPreviousData: true });
  const listRef = useRef<HTMLDivElement>(null);
  // After a review closes, focus returns to that student's row once the refreshed list has arrived (the row
  // may have left the 待评阅 filter, in which case the list itself gets focus).
  const returnFocus = useRef<{ accountId: number; afterLoad: number } | null>(null);
  useEffect(() => {
    const target = returnFocus.current;
    if (!target || openAccountId != null) return;
    if (status === "error") returnFocus.current = null;
    if (loads <= target.afterLoad) return;
    returnFocus.current = null;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`tr[data-account-id="${target.accountId}"] button`);
    (row ?? list?.querySelector<HTMLElement>(".table-wrap"))?.focus();
  }, [loads, status, openAccountId]);
  const reload = () => {
    setRefresh((value) => value + 1);
    onRefresh?.();
  };
  // New submissions arrive while the teacher is in another tab; not while a review is open (it would not show).
  useRefetchOnVisible(() => setRefresh((value) => value + 1), openAccountId == null);
  // The open review comes first: a list refresh failing in the background must not unmount an unsaved review.
  if (openAccountId != null) {
    return <ReportView accountId={openAccountId} grader={user.username} semesters={academic?.semesters ?? []} onBack={(changed) => {
      returnFocus.current = { accountId: openAccountId, afterLoad: loads };
      setOpenAccountId(null);
      setRefresh((value) => value + 1);
      if (changed) onGraded?.();
    }} />;
  }
  if (error || academicError) {
    return <LoadFailure what="报告列表" error={(error ?? academicError)!} onRetry={() => {
      if (error) retry();
      if (academicError) retryAcademic();
    }} />;
  }
  const reports = data?.reports ?? [];
  const semesters = academic?.semesters ?? [];
  const pending = reports.filter((report) => report.state === "pending").length;
  // Normalized like stored names (full-width letters/digits, zero-width characters), then case-folded.
  const needle = normalizeLabel(query).toLowerCase();
  const shown = reports
    .filter((report) => filter === "all" || report.state === filter)
    .filter((report) => matchesAcademicFilter(report.enrollments, semesterId, classId))
    .filter((report) => !needle || [report.display_name, report.username, report.student_no].some((value) => normalizeLabel(value ?? "").toLowerCase().includes(needle)));
  return (
    <div ref={listRef}>
      <Toolbar>
        <div className="segmented">
          {(["pending", "graded", "all"] as Filter[]).map((value) => (
            <button
              key={value}
              className={filter === value ? "active" : undefined}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {REPORT_FILTER_LABELS[value]}
              {value === "pending" && pending > 0 && <span className="seg-badge">{pending}</span>}
            </button>
          ))}
        </div>
        <AcademicFilters
          semesters={semesters}
          semesterId={semesterId}
          classId={classId}
          onSemesterChange={setSemesterId}
          onClassChange={setClassId}
        />
        <SearchInput value={query} onChange={setQuery} placeholder="搜索学生 / 用户名 / 学号" />
        <div className="toolbar-actions">
          <button type="button" onClick={reload}>刷新列表</button>
        </div>
      </Toolbar>
      <p className="muted list-refreshing" role="status">{data && status === "loading" ? "正在刷新列表…" : ""}</p>
      <ScrollableRegion className="table-wrap" label="报告提交列表，可横向滚动">
        <table className="data-table"><thead><tr><th>学生</th><th>用户名</th><th>学号</th><th>班级</th><th>提交时间</th><th>状态</th><th>得分</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
          {shown.map((report) => <tr key={report.account_id} data-account-id={report.account_id}>
            <td className="student-name-cell">{report.display_name}</td><td className="mono">{report.username}</td><td>{report.student_no || "—"}</td>
            <td className="class-memberships">{report.enrollments.length
              ? report.enrollments.map((item) => <span key={item.term_id}>{enrollmentLabel(item, semesters)}</span>)
              : "未分班"}</td><td>{fmtTime(report.submitted_at)}</td>
            <td>{report.state === "graded" ? <StatusPill tone="ok">已评阅</StatusPill> : <StatusPill tone="warn">待评阅</StatusPill>}</td><td>{report.score ?? "—"}</td>
            <td><ReportRowAction report={report} onOpen={() => setOpenAccountId(report.account_id)} /></td>
          </tr>)}
        </tbody></table>
        {data && shown.length === 0 && <EmptyState icon="📝" {...reportsEmptyState(reports.length, filter, Boolean(needle) || semesterId != null)} />}
      </ScrollableRegion>
    </div>
  );
}

export type GradeDraft = { score: string; feedback: string };

function ReportView({ accountId, grader, semesters, onBack }: {
  accountId: number; grader: string; semesters: readonly AcademicSemester[]; onBack: (changed: boolean) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  // What the teacher had typed when a 409 asked for the latest report: carried into the reloaded view.
  const [draft, setDraft] = useState<GradeDraft | null>(null);
  const { data, error, retry } = useAsync<TeacherReport>(() => api.classroom.reportDetail(accountId), [accountId, refresh]);
  if (error) {
    return (
      <div>
        <div className="review-topbar"><button className="back-btn" onClick={() => onBack(false)}>← 返回列表</button></div>
        <LoadFailure what="报告" error={error} onRetry={retry} />
      </div>
    );
  }
  if (!data) return <p className="muted" role="status">加载中…</p>;
  return <GradeView
    key={`${accountId}-${data.updated_at}`}
    data={data}
    grader={grader}
    semesters={semesters}
    onBack={onBack}
    initialDraft={draft ?? undefined}
    onReload={(current) => {
      setDraft(current);
      setRefresh((value) => value + 1);
    }}
  />;
}

export function GradeView({ data, grader, semesters = [], onBack, onReload, initialDraft }: {
  data: TeacherReport;
  grader: string;
  /** Marks an archived class in the header, as the list does. */
  semesters?: readonly AcademicSemester[];
  onBack: (changed: boolean) => void;
  onReload: (draft: GradeDraft) => void;
  /** Score and feedback typed before reloading a newer version of this report. */
  initialDraft?: GradeDraft;
}) {
  const initialScore = data.score == null ? "" : String(data.score);
  const [score, setScore] = useState(initialDraft?.score ?? initialScore);
  const [feedback, setFeedback] = useState(initialDraft?.feedback ?? data.feedback);
  const [feedbackCut, setFeedbackCut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const reviewGuard = useTeacherReviewGuard();
  const dirty = score !== initialScore || feedback !== data.feedback;
  const reloaded = initialDraft != null;
  const ids = useId();
  const formHeadingId = `${ids}-form`;
  const scoreErrorId = `${ids}-score-error`;
  const staleHintId = `${ids}-stale`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const reloadedRef = useRef<HTMLParagraphElement>(null);
  const scoreRef = useRef<HTMLInputElement>(null);
  const saveErrorRef = useModalErrorFocus(saveError);
  // Opening a review puts focus on the student's heading (it was on the list button that just unmounted);
  // after a reload, on the note saying the typed draft was kept.
  useEffect(() => {
    (reloaded ? reloadedRef.current : headingRef.current)?.focus();
  }, [reloaded]);
  useEffect(() => {
    reviewGuard.publish({ dirty, saving });
    return reviewGuard.clear;
  }, [dirty, saving, reviewGuard]);
  const attemptLocalLeave = (leave: () => void) => {
    if (saving) return;
    if (dirty && !window.confirm(LEAVE_MESSAGE)) return;
    reviewGuard.clear();
    leave();
  };
  const submit = () => {
    if (saving || stale) return;
    const numeric = Number(score);
    // Digits only: Number() would also read "1e2" as 100.
    if (!/^\s*\d{1,3}\s*$/.test(score) || !Number.isInteger(numeric) || numeric < 0 || numeric > 100) {
      setScoreError("分数须为 0–100 的整数");
      scoreRef.current?.focus();
      return;
    }
    reviewGuard.publish({ dirty, saving: true });
    setSaving(true);
    setSaveError(null);
    setScoreError(null);
    api.classroom.grade(data.account_id, numeric, feedback.trim(), data.updated_at).then(() => {
      showToast(`已保存对 ${data.display_name} 的评阅：${numeric} 分`);
      reviewGuard.clear();
      onBack(true);
    }, (cause) => {
      setSaving(false);
      setStale(isApiErrorStatus(cause, 409));
      setSaveError(userFacingRequestError(cause, "保存失败"));
    });
  };
  const skipToForm = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    formHeadingRef.current?.focus();
    formHeadingRef.current?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div>
      <div className="review-topbar">
        <button className="back-btn" disabled={saving} onClick={() => attemptLocalLeave(() => onBack(false))}>← 返回列表</button>
        <a className="review-skip" href={`#${formHeadingId}`} onClick={skipToForm}>跳到评阅表单</a>
        <h3 ref={headingRef} tabIndex={-1} className="stage-chip review-student">{data.display_name}（{data.username}）</h3>
        <span className="muted">{data.enrollments.map((item) => enrollmentLabel(item, semesters)).join("；") || "未分班"} · 提交于 {fmtTime(data.submitted_at)}</span>
      </div>
      <div className="grade-split">
        <div className="grade-doc"><ReportMarkdown markdown={data.markdown} /></div>
        <aside className="grade-side"><div className="panel">
          <h3 ref={formHeadingRef} id={formHeadingId} tabIndex={-1} className="panel-head"><span className="panel-ic" aria-hidden="true">🖊️</span>评阅</h3>
          {reloaded && <p ref={reloadedRef} className="muted grade-note" role="status" tabIndex={-1}>{RELOADED_REVIEW_NOTE}</p>}
          <details className="grade-rubric" open>
            <summary>四项评分锚点（建议各 25 分）</summary>
            <ol>
              {GRADE_RUBRIC.map(([title, detail]) => <li key={title}><b>{title}</b><span>{detail}</span></li>)}
            </ol>
          </details>
          <label className="grade-field">分数（0–100）<input ref={scoreRef} type="number" min={0} max={100} disabled={saving} value={score}
            aria-invalid={scoreError ? true : undefined} aria-describedby={scoreError ? scoreErrorId : undefined}
            onChange={(event) => { const next = event.target.value; setScore(next); reviewGuard.publish({ dirty: next !== initialScore || feedback !== data.feedback, saving: false }); setSaveError(null); setScoreError(null); }} /></label>
          {scoreError && <div id={scoreErrorId} className="error-box grade-score-error" role="alert">{scoreError}</div>}
          <label className="grade-field">评语（可空）<textarea disabled={saving} value={feedback} onChange={(event) => {
            // 4000 characters as the server counts them (an emoji is one); only text beyond that is cut, and said so.
            const characters = [...event.target.value];
            const cut = characters.length > 4000;
            const next = cut ? characters.slice(0, 4000).join("") : event.target.value;
            setFeedbackCut(cut);
            setFeedback(next);
            reviewGuard.publish({ dirty: score !== initialScore || next !== data.feedback, saving: false });
            setSaveError(null);
          }} rows={8} /></label>
          {/* Not a live region: announcing the count on every keystroke drowned out typing; only the limit is announced. */}
          <span className="muted grade-count">评语 {[...feedback.trim()].length} / 4000 字</span>
          {feedbackCut && <span className="muted grade-cut" role="status">超过 4000 字上限，多出的内容没有保留。</span>}
          {saveError && <div ref={saveErrorRef} className="error-box" role="alert" tabIndex={-1}>{saveError}</div>}
          {stale && <p id={staleHintId} className="muted grade-note">{STALE_REVIEW_HINT}</p>}
          {/* Nothing typed is lost on reload, so no leave confirmation here. */}
          {stale && <button className="secondary block" disabled={saving} aria-describedby={staleHintId}
            onClick={() => onReload({ score, feedback })}>载入最新报告</button>}
          <button className="primary block" disabled={saving || stale} onClick={submit}>{saving ? "保存中…" : data.state === "graded" ? "更新评阅" : "提交评阅"}</button>
          <p className="muted">评阅人：{grader}；学生重新生成已提交报告时，旧评分会被清除。</p>
        </div></aside>
      </div>
    </div>
  );
}
