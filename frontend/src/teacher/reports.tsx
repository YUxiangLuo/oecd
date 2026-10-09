import { normalizeLabel } from "./text";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
  if (narrowed) return { title: "没有匹配的报告", hint: "请调整筛选条件或关键词" };
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
    return { visible: "查看或修改评分", accessible: `查看或修改评分：${report.display_name}` };
  }
  return { visible: "评阅报告", accessible: `评阅报告：${report.display_name}` };
}

export const GRADE_RUBRIC = [
  ["概念与衔接 · 25", "能讲清数据、指标、图表、回归到报告的关系，术语准确。"],
  ["证据使用 · 25", "引用实际保存的比较、估计值和 95% 区间，数字与报告一致。"],
  ["识别与边界 · 25", "区分描述和因果；说明冲击是模拟的、对照组的大小与可比性、可能有外溢和同期冲击。"],
  ["表达与可复核性 · 25", "研究问题明确，结论、证据与局限一一对应，老师能沿报告记录核对。"],
] as const;

/** Said after the cause of a refused save (another grade, a resubmission); the reload button points here. */
export const STALE_REVIEW_HINT = "点“载入最新报告”查看，已填的分数和评语会保留。";
export const RELOADED_REVIEW_NOTE = "已载入最新报告，并保留了你输入的分数和评语；请核对报告内容后再保存。";
export const UNCHANGED_REVIEW_HINT = "分数和评语都没有修改。";

/** Whether the rubric starts open: open until the teacher's first saved review, then as they last left it. */
const RUBRIC_OPEN_KEY = "gvcsim.teacher.rubric-open";
function rubricStartsOpen(): boolean {
  try {
    return window.localStorage.getItem(RUBRIC_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function rememberRubric(open: boolean, onlyIfUnset = false) {
  try {
    if (onlyIfUnset && window.localStorage.getItem(RUBRIC_OPEN_KEY) != null) return;
    window.localStorage.setItem(RUBRIC_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Private windows may refuse storage; the rubric then just starts open.
  }
}

/** Position of a report in the list it was opened from, for 第 k / n 份 and 上一份/下一份. */
export function reviewPosition(queue: readonly number[], accountId: number) {
  const index = queue.indexOf(accountId);
  if (index < 0) return null;
  return { index, total: queue.length, previous: index > 0 ? queue[index - 1] : null, next: index + 1 < queue.length ? queue[index + 1] : null };
}

export function ReportRowAction({
  report,
  onOpen,
}: {
  report: Pick<TeacherReport, "state" | "display_name">;
  onOpen: () => void;
}) {
  const action = reportRowAction(report);
  // Only the reports still to grade carry the solid button; the graded ones are a quiet secondary action.
  return (
    <button type="button" className={report.state === "graded" ? "sm" : "primary sm"} aria-label={action.accessible} onClick={onOpen}>
      {action.visible}
    </button>
  );
}

/** The teacher pane scrolls, not the window: put it back at the top (the list's toolbar, a report's start). */
function scrollPaneToTop(node: HTMLElement | null) {
  const pane = node?.closest<HTMLElement>(".teacher-main");
  if (pane) pane.scrollTop = 0;
}

export function ReportsTab({ user, initialReview, onGraded, onRefresh }: {
  user: AuthUser;
  /** Open this report first (from the student table), moving through `queue` with 上一份/下一份. */
  initialReview?: { accountId: number; queue: number[] };
  onGraded?: () => void;
  onRefresh?: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [openAccountId, setOpenAccountId] = useState<number | null>(initialReview?.accountId ?? null);
  // The list as it was when a review opened: 上一份/下一份 follow it even as saved reports leave the filter.
  const [queue, setQueue] = useState<number[]>(initialReview?.queue ?? []);
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Opening, moving to another report and going back to the list all start at the top of the pane.
  useLayoutEffect(() => scrollPaneToTop(rootRef.current), [openAccountId]);
  // After a review closes, focus returns to that student's row once the refreshed list has arrived (the row
  // may have left the 待评阅 filter, in which case the list itself gets focus). The pane stays at the top,
  // with the toolbar in view.
  const returnFocus = useRef<{ accountId: number; afterLoad: number } | null>(null);
  useEffect(() => {
    const target = returnFocus.current;
    if (!target || openAccountId != null) return;
    if (status === "error") returnFocus.current = null;
    if (loads <= target.afterLoad) return;
    returnFocus.current = null;
    const list = rootRef.current;
    const row = list?.querySelector<HTMLElement>(`tr[data-account-id="${target.accountId}"] button`);
    (row ?? list?.querySelector<HTMLElement>(".table-wrap"))?.focus({ preventScroll: true });
  }, [loads, status, openAccountId]);
  const reload = () => {
    setRefresh((value) => value + 1);
    onRefresh?.();
  };
  const saved = () => {
    setRefresh((value) => value + 1);
    onGraded?.();
  };
  // New submissions arrive while the teacher is in another tab; not while a review is open (it would not show).
  useRefetchOnVisible(() => setRefresh((value) => value + 1), openAccountId == null);
  const reports = data?.reports ?? [];
  const semesters = academic?.semesters ?? [];
  // Normalized like stored names (full-width letters/digits, zero-width characters), then case-folded.
  const needle = normalizeLabel(query).toLowerCase();
  const shown = reports
    .filter((report) => filter === "all" || report.state === filter)
    .filter((report) => matchesAcademicFilter(report.enrollments, semesterId, classId))
    .filter((report) => !needle || [report.display_name, report.username, report.student_no].some((value) => normalizeLabel(value ?? "").toLowerCase().includes(needle)));
  // The open review comes first: a list refresh failing in the background must not unmount an unsaved review.
  if (openAccountId != null) {
    return <div ref={rootRef}><ReportView key={openAccountId} accountId={openAccountId} queue={queue}
      grader={user.name || user.username} semesters={semesters}
      onMove={(accountId, changed) => {
        if (changed) saved();
        setOpenAccountId(accountId);
      }}
      onBack={(changed) => {
        returnFocus.current = { accountId: openAccountId, afterLoad: loads };
        setOpenAccountId(null);
        if (changed) saved();
        else setRefresh((value) => value + 1);
      }} /></div>;
  }
  if (error || academicError) {
    return <LoadFailure what={error ? "报告列表" : "学期列表"} error={(error ?? academicError)!} onRetry={() => {
      if (error) retry();
      if (academicError) retryAcademic();
    }} />;
  }
  const pending = reports.filter((report) => report.state === "pending").length;
  const open = (accountId: number) => {
    setQueue(shown.map((report) => report.account_id));
    setOpenAccountId(accountId);
  };
  return (
    <div ref={rootRef}>
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
        <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名、用户名或学号" />
        <div className="toolbar-actions">
          <button type="button" onClick={reload}>刷新列表</button>
        </div>
      </Toolbar>
      <p className="muted list-refreshing" role="status">{data && status === "loading" ? "正在刷新列表…" : ""}</p>
      <ScrollableRegion className="table-wrap" label="报告提交列表，可横向滚动">
        <table className="data-table"><thead><tr><th>姓名</th><th>用户名</th><th>学号</th><th>班级</th><th>提交时间</th><th>状态</th><th>分数</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
          {shown.map((report) => <tr key={report.account_id} data-account-id={report.account_id}>
            <td className="student-name-cell">{report.display_name}</td><td className="mono">{report.username}</td><td>{report.student_no || "—"}</td>
            <td className="class-memberships">{report.enrollments.length
              ? report.enrollments.map((item) => { const label = enrollmentLabel(item, semesters); return <span key={item.term_id} title={label}>{label}</span>; })
              : "未分班"}</td><td>{fmtTime(report.submitted_at)}</td>
            <td>{report.state === "graded" ? <StatusPill tone="ok">已评阅</StatusPill> : <StatusPill tone="warn">待评阅</StatusPill>}</td><td>{report.score ?? "—"}</td>
            <td><ReportRowAction report={report} onOpen={() => open(report.account_id)} /></td>
          </tr>)}
        </tbody></table>
        {data && shown.length === 0 && <EmptyState icon="📝" {...reportsEmptyState(reports.length, filter, Boolean(needle) || semesterId != null)} />}
      </ScrollableRegion>
    </div>
  );
}

export type GradeDraft = { score: string; feedback: string };

function ReportView({ accountId, queue, grader, semesters, onBack, onMove }: {
  accountId: number; queue: readonly number[]; grader: string; semesters: readonly AcademicSemester[];
  onBack: (changed: boolean) => void;
  /** Open another report of the queue; `changed` when this one was just saved. */
  onMove: (accountId: number, changed: boolean) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  // What the teacher had typed when a 409 asked for the latest report: carried into the reloaded view.
  const [draft, setDraft] = useState<GradeDraft | null>(null);
  const { data, error, retry } = useAsync<TeacherReport>(() => api.classroom.reportDetail(accountId), [accountId, refresh]);
  const position = reviewPosition(queue, accountId);
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
    position={position ?? undefined}
    onPrevious={position?.previous != null ? () => onMove(position.previous!, false) : undefined}
    onNext={position?.next != null ? (changed) => onMove(position.next!, changed) : undefined}
    initialDraft={draft ?? undefined}
    onReload={(current) => {
      setDraft(current);
      setRefresh((value) => value + 1);
    }}
  />;
}

export function GradeView({ data, grader, semesters = [], onBack, onReload, initialDraft, position, onPrevious, onNext }: {
  data: TeacherReport;
  grader: string;
  /** Marks an archived class in the header, as the list does. */
  semesters?: readonly AcademicSemester[];
  onBack: (changed: boolean) => void;
  onReload: (draft: GradeDraft) => void;
  /** Score and feedback typed before reloading a newer version of this report. */
  initialDraft?: GradeDraft;
  /** Where this report sits in the list it was opened from (第 k / n 份). */
  position?: { index: number; total: number };
  onPrevious?: () => void;
  /** Go to the next report; `changed` when this one was just saved. */
  onNext?: (changed: boolean) => void;
}) {
  const initialScore = data.score == null ? "" : String(data.score);
  const [score, setScore] = useState(initialDraft?.score ?? initialScore);
  const [feedback, setFeedback] = useState(initialDraft?.feedback ?? data.feedback);
  const [feedbackCut, setFeedbackCut] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [rubricOpen] = useState(rubricStartsOpen);
  const reviewGuard = useTeacherReviewGuard();
  const dirty = score !== initialScore || feedback !== data.feedback;
  // Re-saving an unchanged grade only moved its timestamp.
  const unchanged = data.state === "graded" && !dirty;
  const reloaded = initialDraft != null;
  const ids = useId();
  const formHeadingId = `${ids}-form`;
  const scoreErrorId = `${ids}-score-error`;
  const saveErrorId = `${ids}-save-error`;
  const unchangedId = `${ids}-unchanged`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const reloadedRef = useRef<HTMLParagraphElement>(null);
  const scoreRef = useRef<HTMLInputElement>(null);
  const rubricRef = useRef<HTMLDetailsElement>(null);
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
  const submit = (thenNext: boolean) => {
    if (saving || stale || unchanged) return;
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
      // After the first saved review the rubric starts folded, unless the teacher chose otherwise.
      rememberRubric(false, true);
      reviewGuard.clear();
      if (thenNext && onNext) onNext(true);
      else onBack(true);
    }, (cause) => {
      setSaving(false);
      const conflict = isApiErrorStatus(cause, 409);
      setStale(conflict);
      if (conflict) {
        // One message: what changed (from the server) and what to do about it.
        const reason = userFacingRequestError(cause, "没有保存");
        setSaveError(`${reason}${/[。！？.!?]$/.test(reason) ? "" : "。"}${STALE_REVIEW_HINT}`);
      } else {
        setSaveError(userFacingRequestError(cause, "保存失败"));
      }
    });
  };
  const skipToForm = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    formHeadingRef.current?.focus();
    formHeadingRef.current?.scrollIntoView({ block: "nearest" });
  };
  const saveLabel = saving ? "保存中…" : data.state === "graded" ? "更新评阅" : "提交评阅";
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
        <aside className="grade-side"><div className="panel grade-panel">
          <div className="grade-panel-head">
            <h3 ref={formHeadingRef} id={formHeadingId} tabIndex={-1} className="panel-head"><span className="panel-ic" aria-hidden="true">🖊️</span>评阅</h3>
            {/* The report is long: the student stays named here while the top bar scrolls away. */}
            <p className="grade-panel-student" title={`${data.display_name}（${data.username}）`}>{data.display_name}<span>（{data.username}）</span></p>
            {position && (
              <div className="grade-queue" role="group" aria-label="切换报告">
                <button type="button" className="sm" disabled={saving || !onPrevious} onClick={() => onPrevious && attemptLocalLeave(onPrevious)}>‹ 上一份</button>
                <span className="grade-queue-count">第 {position.index + 1} / {position.total} 份</span>
                <button type="button" className="sm" disabled={saving || !onNext} onClick={() => onNext && attemptLocalLeave(() => onNext(false))}>下一份 ›</button>
              </div>
            )}
          </div>
          <div className="grade-panel-body">
            {reloaded && <p ref={reloadedRef} className="muted grade-note" role="status" tabIndex={-1}>{RELOADED_REVIEW_NOTE}</p>}
            <details ref={rubricRef} className="grade-rubric" open={rubricOpen}>
              {/* Only the teacher's own clicks are remembered (a toggle event also fires when the page sets `open`). */}
              <summary onClick={() => rememberRubric(!rubricRef.current?.open)}>评分参考（四项各 25 分）</summary>
              <ol>
                {GRADE_RUBRIC.map(([title, detail]) => <li key={title}><b>{title}</b><span>{detail}</span></li>)}
              </ol>
            </details>
            <label className="grade-field">评语（选填）<textarea disabled={saving} value={feedback} onChange={(event) => {
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
          </div>
          {/* Always in view at the bottom of the panel: the score and the save buttons. */}
          <div className="grade-panel-foot">
            <label className="grade-field grade-score">分数（0–100）<input ref={scoreRef} type="number" min={0} max={100} disabled={saving} value={score}
              aria-invalid={scoreError ? true : undefined} aria-describedby={scoreError ? scoreErrorId : undefined}
              onChange={(event) => { const next = event.target.value; setScore(next); reviewGuard.publish({ dirty: next !== initialScore || feedback !== data.feedback, saving: false }); setSaveError(null); setScoreError(null); }} /></label>
            {scoreError && <div id={scoreErrorId} className="error-box grade-score-error" role="alert">{scoreError}</div>}
            {saveError && <div ref={saveErrorRef} id={saveErrorId} className="error-box grade-save-error" role="alert" tabIndex={-1}>{saveError}</div>}
            {/* Nothing typed is lost on reload, so no leave confirmation here. */}
            {stale && <button className="secondary block" disabled={saving} aria-describedby={saveErrorId}
              onClick={() => onReload({ score, feedback })}>载入最新报告</button>}
            {onNext && <button className="primary block" disabled={saving || stale || unchanged}
              aria-describedby={unchanged ? unchangedId : undefined} onClick={() => submit(true)}>{saving ? "保存中…" : "保存并评阅下一份"}</button>}
            <button className={`${onNext ? "secondary" : "primary"} block`} disabled={saving || stale || unchanged}
              aria-describedby={unchanged ? unchangedId : undefined} onClick={() => submit(false)}>{saveLabel}</button>
            {unchanged && <p id={unchangedId} className="muted grade-unchanged">{UNCHANGED_REVIEW_HINT}</p>}
            <p className="muted grade-grader">评阅人：{grader}。学生重新生成报告后，本次评分会被清除。</p>
          </div>
        </div></aside>
      </div>
    </div>
  );
}
