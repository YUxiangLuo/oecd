import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AcademicSemester, StudentRow } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { AcademicFilters, matchesAcademicFilter, enrollmentLabel, UNASSIGNED_CLASS } from "./academic-filter";
import { batchClassOptions, StudentBatchModal } from "./student-batch";
import { normalizeLabel, stripInvisibleEdges } from "./text";
import { EmptyState, LoadFailure, Modal, SearchInput, StatusPill, Toolbar, useFieldErrorFocus, useModalErrorFocus, useRefetchOnVisible } from "./ui";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";
// No maxLength on password fields: a pasted longer password would be cut silently (it is masked) and the
// handed-out password would not work. studentFieldError says so instead.
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_INPUT_PROPS = { type: "password", autoComplete: "new-password" } as const;
export const VALID_ACTIVITY_HINT = "最近一次保存实验记录、生成或提交报告的时间（仅登录或浏览不计）";
export const DEMO_PASSWORD_HINT = "演示账号不能修改密码。要演示改密码，请新建一个学生账号。";
export const RESET_PASSWORD_NOTE = "保存后该学生要用新密码重新登录，请把新密码告诉他。";

export async function settleModalSubmission(
  operation: () => Promise<void>,
  onClose: () => void,
  setError: (value: string | null) => void,
  setSaving: (value: boolean) => void,
) {
  setSaving(true);
  setError(null);
  try {
    await operation();
    onClose();
    return true;
  } catch (cause) {
    setError(userFacingRequestError(cause, "保存失败"));
    return false;
  } finally {
    setSaving(false);
  }
}

export const STUDENT_NAME_MAX_LENGTH = 60;
export const STUDENT_NO_MAX_LENGTH = 40;

export function studentFieldError(
  value: string,
  { label, password = false, required = true, maxLength }: { label: string; password?: boolean; required?: boolean; maxLength?: number },
) {
  if (password && value.length < 12) return "密码至少 12 个字符";
  if (password && value.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`;
  if (password && !value.trim()) return "密码不能全是空格";
  // Names and 学号 are checked in the form the server stores them (zero-width characters, full-width
  // letters and repeated spaces normalized), so a name of only invisible characters is blank here too.
  const normalized = password ? value : normalizeLabel(value);
  if (!password && required && !normalized) return `${label}不能为空`;
  if (!password && maxLength != null && normalized.length > maxLength) return `${label}不能超过 ${maxLength} 个字符`;
  return null;
}

type NewStudent = { username: string; display_name: string; password: string; student_no: string; class_id?: number };
type NewStudentField = "username" | "display_name" | "student_no" | "password";

/** The create form's first problem and the field it is about, checked as the server will (usernames and 学号 are compared exactly, so trimmed). */
export function newStudentProblem(student: NewStudent): { field: NewStudentField; message: string } | null {
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(stripInvisibleEdges(student.username))) {
    return { field: "username", message: "用户名须为 2–40 位字母、数字、下划线、点或连字符" };
  }
  const checks: [NewStudentField, string | null][] = [
    ["display_name", studentFieldError(student.display_name, { label: "姓名", maxLength: STUDENT_NAME_MAX_LENGTH })],
    ["student_no", studentFieldError(student.student_no, { label: "学号", required: false, maxLength: STUDENT_NO_MAX_LENGTH })],
    ["password", studentFieldError(student.password, { label: "初始密码", password: true })],
  ];
  const problem = checks.find(([, message]) => message != null);
  return problem ? { field: problem[0], message: problem[1]! } : null;
}

export function newStudentError(student: NewStudent): string | null {
  return newStudentProblem(student)?.message ?? null;
}

type ModalState = null | { type: "student" } | { type: "batch" } | { type: "name" | "student_no" | "password" | "enrollment"; student: StudentRow };

/* ---------- 排序与汇总 ---------- */

export type StudentSortKey = "name" | "student_no" | "progress" | "report" | "score" | "activity" | "login";
export type StudentSort = { key: StudentSortKey; direction: "ascending" | "descending" } | null;

/** 未生成 → 草稿 → 待评阅 → 已评阅: ascending puts the students furthest from handing in first. */
const REPORT_RANK = { none: 0, draft: 1, pending: 2, graded: 3 } as const;

function sortValue(student: StudentRow, key: StudentSortKey): string | number | null {
  switch (key) {
    case "name": return student.display_name;
    case "student_no": return student.student_no || null;
    case "progress": return student.verified_completed_count;
    case "report": return REPORT_RANK[student.report_state ?? "none"];
    case "score": return student.score;
    case "activity": return student.last_valid_activity;
    case "login": return student.last_login_at;
  }
}

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });

/** Sorted copy of the rows. Missing values (no 学号, no score, never logged in) go last in either direction. */
export function sortStudents(students: readonly StudentRow[], sort: StudentSort): StudentRow[] {
  if (!sort) return [...students];
  const sign = sort.direction === "ascending" ? 1 : -1;
  return [...students].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left == null || right == null) {
      if (left != null) return -1;
      if (right != null) return 1;
    } else {
      const order = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
      if (order) return order * sign;
    }
    return collator.compare(a.display_name, b.display_name) || a.id - b.id;
  });
}

/** The next sort after a header click: a new column starts ascending, the same column flips. */
export function nextStudentSort(sort: StudentSort, key: StudentSortKey): StudentSort {
  if (sort?.key !== key) return { key, direction: "ascending" };
  return { key, direction: sort.direction === "ascending" ? "descending" : "ascending" };
}

export type StudentSummary = {
  total: number; notStarted: number; inProgress: number; pending: number; graded: number; averageScore: number | null;
};

/** Counts for the summary bar, over the rows the filters leave. Every student is in exactly one bucket. */
export function summarizeStudents(students: readonly StudentRow[]): StudentSummary {
  const summary: StudentSummary = { total: students.length, notStarted: 0, inProgress: 0, pending: 0, graded: 0, averageScore: null };
  const scores: number[] = [];
  for (const student of students) {
    if (student.report_state === "graded") summary.graded++;
    else if (student.report_state === "pending") summary.pending++;
    else if (student.verified_completed_count > 0 || student.report_state === "draft" || student.last_valid_activity) summary.inProgress++;
    else summary.notStarted++;
    if (student.score != null) scores.push(student.score);
  }
  if (scores.length) summary.averageScore = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 10) / 10;
  return summary;
}

export function StudentSummaryBar({ summary }: { summary: StudentSummary }) {
  const items: [string, string | number, string?][] = [
    ["共", `${summary.total} 人`],
    ["未开始", summary.notStarted],
    ["进行中", summary.inProgress],
    ["已提交待评阅", summary.pending],
    ["已评阅", summary.graded],
    ["平均分", summary.averageScore ?? "—", "已评阅报告的平均分"],
  ];
  return (
    <ul className="student-summary" aria-label="当前列表概况">
      {items.map(([label, value, hint]) => <li key={label} title={hint}><span>{label}</span><b>{value}</b></li>)}
    </ul>
  );
}

function SortableHeader({ label, sortKey, sort, onSort, className, title, describedBy }: {
  label: string; sortKey: StudentSortKey; sort: StudentSort; onSort: (key: StudentSortKey) => void;
  className?: string; title?: string; describedBy?: string;
}) {
  const active = sort?.key === sortKey;
  return (
    <th className={className} title={title} aria-describedby={describedBy} aria-sort={active ? sort.direction : undefined}>
      <button type="button" className="table-sort" onClick={() => onSort(sortKey)}>
        {label}<span className={`sort-ic${active ? " active" : ""}`} aria-hidden="true">{active ? (sort.direction === "ascending" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

/** The report status; a submitted report opens in 报告评阅 from here. */
export function ReportStateCell({ student, onOpen }: { student: StudentRow; onOpen?: () => void }) {
  const state = student.report_state;
  const pill = state === "graded" ? <StatusPill tone="ok">已评阅</StatusPill>
    : state === "pending" ? <StatusPill tone="warn">待评阅</StatusPill>
      : state === "draft" ? <StatusPill tone="muted">草稿（未提交）</StatusPill> : <StatusPill tone="muted">未生成</StatusPill>;
  if (!onOpen || (state !== "pending" && state !== "graded")) return pill;
  const visible = state === "pending" ? "待评阅" : "已评阅";
  return (
    <button type="button" className="pill-button" title="在“报告评阅”中打开" onClick={onOpen}
      aria-label={`${visible}，打开报告：${student.display_name}（${student.username}）`}>{pill}</button>
  );
}

/**
 * 行内操作菜单。可访问名必须带上学生身份：否则一页里会出现成百上千个同名的“操作 /
 * 修改姓名 / 重置密码”，屏幕阅读器无法判断菜单属于哪个学生。可见文字保持不变。
 */
export function StudentRowMenu({
  student,
  onPick,
}: {
  student: StudentRow;
  onPick: (type: "name" | "student_no" | "password" | "enrollment", student: StudentRow) => void;
}) {
  const who = `${student.display_name}（${student.username}）`;
  // Close the menu on a pick; otherwise it stayed open behind the modal and after saving. Focus moves to
  // the menu's ⋯ first, so the modal returns focus there (the picked item is hidden once the menu closes).
  const pick = (event: React.MouseEvent<HTMLElement>, type: "name" | "student_no" | "password" | "enrollment") => {
    const menu = event.currentTarget.closest("details");
    menu?.removeAttribute("open");
    menu?.querySelector("summary")?.focus();
    onPick(type, student);
  };
  return (
    <details className="row-menu" onPointerDown={(event) => {
      const menu = event.currentTarget;
      menu.dataset.pointerDown = "1";
      window.addEventListener("pointerup", () => { window.setTimeout(() => { delete menu.dataset.pointerDown; }, 0); }, { once: true });
    }} onKeyDown={(event) => {
      // Escape closes the menu and returns to its ⋯, like other menus.
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.currentTarget.removeAttribute("open");
      event.currentTarget.querySelector("summary")?.focus();
    }} onBlur={(event) => {
      // Tabbing out of an open menu closes it. Without a next focus target (a click on the page), the
      // pointerdown listener decides, so a click on a menu item in browsers that do not focus buttons still lands.
      const next = event.relatedTarget;
      const menu = event.currentTarget;
      if (next instanceof Node && !menu.contains(next)) menu.removeAttribute("open");
      // Tabbing past the last row leaves no next target; close once focus has really left the menu.
      // (Not while a pointer is pressed in the menu: that click is choosing an item.)
      else if (next == null && menu.dataset.pointerDown !== "1") {
        window.setTimeout(() => { if (!menu.contains(document.activeElement)) menu.removeAttribute("open"); }, 0);
      }
    }} onToggle={(event) => {
      const menu = event.currentTarget;
      if (!menu.open) return;
      // One menu at a time: opening this one closes the others.
      document.querySelectorAll<HTMLDetailsElement>(".row-menu[open]").forEach((other) => { if (other !== menu) other.open = false; });
      const region = menu.closest<HTMLElement>(".student-table-scroll");
      const popup = menu.querySelector<HTMLElement>(".row-menu-pop");
      if (!region || !popup) return;
      const overflow = popup.getBoundingClientRect().bottom - region.getBoundingClientRect().bottom;
      if (overflow > 0) region.scrollTop += overflow + 8;
    }}>
      <summary aria-label={`操作：${who}`} title="更多操作">⋯</summary>
      <div className="row-menu-pop">
        <button aria-label={`修改姓名：${who}`} onClick={(event) => pick(event, "name")}>修改姓名</button>
        <button aria-label={`修改学号：${who}`} onClick={(event) => pick(event, "student_no")}>修改学号</button>
        <button aria-label={`调整班级：${who}`} onClick={(event) => pick(event, "enrollment")}>调整班级</button>
        <span title={student.demo_seed ? DEMO_PASSWORD_HINT : undefined}>
          <button
            disabled={student.demo_seed}
            aria-label={`重置密码：${who}`}
            onClick={(event) => pick(event, "password")}
          >
            重置密码
          </button>
        </span>
      </div>
    </details>
  );
}

/** Mark the table region while columns are hidden under the sticky 操作 column, so it can cast a shadow. */
function markHiddenColumns(region: HTMLElement | null | undefined) {
  if (!region) return;
  region.dataset.moreRight = region.scrollLeft + region.clientWidth < region.scrollWidth - 1 ? "true" : "false";
}

export function StudentsTab({ onOpenReport }: {
  /** Open a submitted report in 报告评阅; `queue` is the table's submitted reports in their current order. */
  onOpenReport?: (accountId: number, queue: number[]) => void;
} = {}) {
  const activityHintId = useId();
  const [refresh, setRefresh] = useState(0);
  // A click outside an open row menu closes it (native <details> stays open otherwise).
  useEffect(() => {
    const close = (event: PointerEvent) => {
      document.querySelectorAll<HTMLDetailsElement>(".row-menu[open]").forEach((menu) => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const [query, setQuery] = useState("");
  const [semesterId, setSemesterId] = useState<number | null>(null);
  const [classId, setClassId] = useState<number | null>(null);
  const [sort, setSort] = useState<StudentSort>(null);
  const [modal, setModal] = useState<ModalState>(null);
  // Keep the table while it reloads after an edit: clearing it flashed "暂无学生" and lost the scroll position.
  const { data, error, status, retry } = useAsync<{ students: StudentRow[] }>(() => api.classroom.students(), [refresh], { keepPreviousData: true });
  // Progress changes during class: refresh when the teacher comes back to this tab (not while a dialog is open).
  useRefetchOnVisible(() => setRefresh((value) => value + 1), modal == null);
  const { data: academic, error: academicError, retry: retryAcademic } = useAsync(() => api.classroom.semesters(), [refresh], { keepPreviousData: true });
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => markHiddenColumns(tableRef.current?.querySelector<HTMLElement>(".student-table-scroll"));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  });

  const run = async (operation: Promise<unknown>) => {
    await operation;
    setRefresh((value) => value + 1);
  };

  if (error || academicError) {
    return <LoadFailure what={error ? "学生列表" : "学期列表"} error={(error ?? academicError)!} onRetry={() => {
      if (error) retry();
      if (academicError) retryAcademic();
    }} />;
  }
  const all = data?.students ?? [];
  const semesters = academic?.semesters ?? [];
  // Normalized like stored names (full-width letters/digits, zero-width characters), then case-folded.
  const needle = normalizeLabel(query).toLowerCase();
  const students = sortStudents(all
    .filter((student) => matchesAcademicFilter(student.enrollments, semesterId, classId))
    .filter((student) => !needle || [student.display_name, student.username, student.student_no]
      .some((value) => normalizeLabel(value ?? "").toLowerCase().includes(needle))), sort);
  const submitted = students.filter((student) => student.report_state === "pending" || student.report_state === "graded").map((student) => student.id);
  // The batch import starts in the class being looked at, when it can still take students.
  const batchClassId = classId != null && classId !== UNASSIGNED_CLASS && batchClassOptions(semesters).some((option) => option.id === classId) ? classId : null;
  const header = (label: string, key: StudentSortKey, extra: { className?: string; title?: string; describedBy?: string } = {}) =>
    <SortableHeader label={label} sortKey={key} sort={sort} onSort={(next) => setSort((current) => nextStudentSort(current, next))} {...extra} />;

  return (
    <div>
      <Toolbar>
        <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名、用户名或学号" />
        <AcademicFilters
          semesters={semesters}
          semesterId={semesterId}
          classId={classId}
          onSemesterChange={setSemesterId}
          onClassChange={setClassId}
        />
        <div className="toolbar-actions">
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>刷新列表</button>
          <button type="button" onClick={() => setModal({ type: "batch" })}>批量导入学生</button>
          <button className="primary" onClick={() => setModal({ type: "student" })}>+ 添加学生</button>
        </div>
      </Toolbar>
      {data && <StudentSummaryBar summary={summarizeStudents(students)} />}
      {/* The previous rows stay while a refresh loads; say so, since they may be a moment out of date. */}
      <p className="muted list-refreshing" role="status">{data && status === "loading" ? "正在刷新列表…" : ""}</p>
      <p id={activityHintId} className="sr-only">最近操作：{VALID_ACTIVITY_HINT}</p>
      <div ref={tableRef}>
        <ScrollableRegion className="table-wrap student-table-scroll" label="学生进度表，可横向及纵向滚动"
          onScroll={(event) => markHiddenColumns(event.currentTarget)}>
          <table className="data-table">
            <thead><tr>{header("姓名", "name")}<th>用户名</th>{header("学号", "student_no")}<th>班级</th>
              {header("完成进度", "progress")}{header("报告", "report")}{header("分数", "score")}
              {header("最近操作", "activity", { className: "th-hint", title: VALID_ACTIVITY_HINT, describedBy: activityHintId })}
              {header("最近登录", "login")}<th>操作</th></tr></thead>
            <tbody>
              {students.map((student) => (
                <tr key={student.id}>
                  <td className="student-name-cell">{student.display_name}</td>
                  <td className="mono">{student.username}</td>
                  <td className="student-no-cell" title={student.student_no || undefined}>{student.student_no || "—"}</td>
                  <td className="class-memberships">{student.enrollments.length
                    ? student.enrollments.map((item) => { const label = enrollmentLabel(item, semesters); return <span key={item.term_id} title={label}>{label}</span>; })
                    : "未分班"}</td>
                  <td title={`已完成步骤：${student.verified_completed_steps.join("、") || "无"}`}>
                    <span className="step-cell"><span className="mini-track verified"><span className="mini-bar" style={{ width: `${student.verified_completed_count / student.verified_total_steps * 100}%` }} /></span>{student.verified_completed_count}/{student.verified_total_steps}</span>
                  </td>
                  <td><ReportStateCell student={student} onOpen={onOpenReport && (() => onOpenReport(student.id, submitted))} /></td>
                  <td>{student.score ?? "—"}</td>
                  <td>{fmtTime(student.last_valid_activity)}</td>
                  <td>{fmtTime(student.last_login_at)}</td>
                  <td>
                    <StudentRowMenu student={student} onPick={(type, picked) => setModal({ type, student: picked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && students.length === 0 && <EmptyState
            icon="👥"
            title={all.length ? "没有匹配的学生" : "暂无学生"}
            hint={all.length
              ? (needle || semesterId != null || classId != null ? "试试清除搜索或学期/班级筛选" : "换个关键词试试")
              : "点右上角“+ 添加学生”或“批量导入学生”"}
          />}
        </ScrollableRegion>
      </div>

      {modal?.type === "student" && <StudentModal semesters={semesters} onClose={() => setModal(null)} onSubmit={(body) => run(api.classroom.createStudent(body))} />}
      {modal?.type === "batch" && <StudentBatchModal semesters={semesters} initialClassId={batchClassId}
        onClose={() => setModal(null)} onCreated={() => setRefresh((value) => value + 1)} />}
      {modal?.type === "enrollment" && (
        <EnrollmentModal
          student={modal.student}
          semesters={semesters}
          onClose={() => setModal(null)}
          onSubmit={(termId, nextClassId) => run(api.classroom.setEnrollment(modal.student.id, termId, nextClassId))}
        />
      )}
      {modal && (modal.type === "name" || modal.type === "student_no" || modal.type === "password") && (
        <FieldModal
          title={modal.type === "name" ? `修改 ${modal.student.display_name} 的姓名`
            : modal.type === "student_no" ? `修改 ${modal.student.display_name} 的学号` : `重置 ${modal.student.display_name} 的密码`}
          label={modal.type === "name" ? "姓名" : modal.type === "student_no" ? "学号" : "新密码（至少 12 个字符）"}
          note={modal.type === "password" ? RESET_PASSWORD_NOTE : undefined}
          initial={modal.type === "name" ? modal.student.display_name : modal.type === "student_no" ? modal.student.student_no : ""}
          password={modal.type === "password"}
          required={modal.type !== "student_no"}
          maxLength={modal.type === "name" ? STUDENT_NAME_MAX_LENGTH : modal.type === "student_no" ? STUDENT_NO_MAX_LENGTH : undefined}
          onClose={() => setModal(null)}
          onSubmit={(value) => run(api.classroom.updateStudent(modal.student.id, { [modal.type === "name" ? "display_name" : modal.type]: value }))}
        />
      )}
    </div>
  );
}

/** A form field with a one-line hint under it, linked to the input. */
function HintedField({ label, hint, children }: { label: string; hint: string; children: (id: string, hintId: string) => ReactNode }) {
  const hintId = useId();
  return (
    <LabeledControl label={label}>{(id) => <>
      {children(id, hintId)}
      <p id={hintId} className="field-hint">{hint}</p>
    </>}</LabeledControl>
  );
}

export function StudentModal({ semesters = [], onClose, onSubmit }: { semesters?: AcademicSemester[]; onClose: () => void; onSubmit: (body: { username: string; display_name: string; password: string; student_no: string; class_id?: number }) => Promise<void> }) {
  const [form, setForm] = useState<{ username: string; display_name: string; password: string; student_no: string; class_id?: number }>({ username: "", display_name: "", password: "", student_no: "" });
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<NewStudentField | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  const fields: Record<NewStudentField, RefObject<HTMLInputElement | null>> = {
    username: useRef<HTMLInputElement>(null),
    display_name: useRef<HTMLInputElement>(null),
    student_no: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };
  // A check that names its field sends focus there; a server refusal goes to the error box.
  const errorRef = useFieldErrorFocus(error, errorField ? fields[errorField] : null);
  const close = () => { if (!saving) onClose(); };
  const fieldProps = (field: NewStudentField) => ({
    ref: fields[field],
    "aria-invalid": errorField === field ? true : undefined,
    "aria-describedby": errorField === field ? errorId : undefined,
  });
  const submit = async () => {
    const body = {
      ...form,
      username: stripInvisibleEdges(form.username),
      display_name: normalizeLabel(form.display_name),
      student_no: normalizeLabel(form.student_no),
    };
    const problem = newStudentProblem(body);
    if (problem) {
      setError(problem.message);
      setErrorField(problem.field);
      fields[problem.field].current?.focus();
      return;
    }
    setErrorField(null);
    await settleModalSubmission(() => onSubmit(body), onClose, setError, setSaving);
  };
  return (
    <Modal title="添加学生账号" onClose={close}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <HintedField label="用户名（登录用）" hint="2–40 位英文字母、数字或 _ . -；建议填学号（批量导入时学号就是用户名）">{(id, hintId) =>
        <input id={id} name="student-username" disabled={saving} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })}
          {...fieldProps("username")} aria-describedby={errorField === "username" ? `${hintId} ${errorId}` : hintId} />}</HintedField>
      <LabeledControl label="姓名">{(id) => <input id={id} name="student-display-name" disabled={saving} value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} {...fieldProps("display_name")} />}</LabeledControl>
      <LabeledControl label="学号（选填）">{(id) => <input id={id} name="student-number" disabled={saving} value={form.student_no} onChange={(event) => setForm({ ...form, student_no: event.target.value })} {...fieldProps("student_no")} />}</LabeledControl>
      <LabeledControl label="班级（选填）">{(id) => <select id={id} disabled={saving} value={form.class_id ?? ""} onChange={(event) => setForm({ ...form, class_id: event.target.value ? Number(event.target.value) : undefined })}>
        <option value="">暂不分班</option>
        {batchClassOptions(semesters).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>}</LabeledControl>
      <LabeledControl label="初始密码（至少 12 个字符）">{(id) => <input id={id} name="student-password" disabled={saving} {...PASSWORD_INPUT_PROPS} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} {...fieldProps("password")} />}</LabeledControl>
      {error && <div ref={errorRef} id={errorId} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
      <div className="modal-actions"><button type="button" disabled={saving} onClick={close}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "创建中…" : "创建账号"}</button></div>
    </form></Modal>
  );
}

export function EnrollmentModal({ student, semesters, onClose, onSubmit }: {
  student: StudentRow;
  semesters: AcademicSemester[];
  onClose: () => void;
  onSubmit: (termId: number, classId: number | null) => Promise<void>;
}) {
  const availableSemesters = semesters.filter((semester) =>
    semester.is_active || student.enrollments.some((item) => item.term_id === semester.id)
  );
  const initialTerm = availableSemesters.find((semester) => semester.is_active)?.id ?? availableSemesters[0]?.id ?? null;
  const [termId, setTermId] = useState<number | null>(initialTerm);
  const existing = student.enrollments.find((item) => item.term_id === termId);
  const [classId, setClassId] = useState<number | null>(existing?.class_id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useModalErrorFocus(error);
  const semester = semesters.find((item) => item.id === termId);
  const hasArchived = availableSemesters.some((item) => !item.is_active) || Boolean(semester?.classes.some((group) => !group.is_active && existing?.class_id === group.id));
  const submit = async () => {
    if (termId == null) return setError("请先到“学期与班级”新建学期");
    setSaving(true);
    setError(null);
    try {
      await onSubmit(termId, classId);
      onClose();
    } catch (cause) {
      setError(userFacingRequestError(cause, "保存失败"));
      setSaving(false);
    }
  };
  return (
    <Modal title={`调整 ${student.display_name} 的班级`} onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <LabeledControl label="学期">{(id) => <select id={id} disabled={saving} value={termId ?? ""} onChange={(event) => {
          const nextTerm = event.target.value ? Number(event.target.value) : null;
          setTermId(nextTerm);
          setClassId(student.enrollments.find((item) => item.term_id === nextTerm)?.class_id ?? null);
        }}>
          <option value="">请选择学期</option>
          {availableSemesters.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? "" : "（已归档）"}</option>)}
        </select>}</LabeledControl>
        <LabeledControl label="班级">{(id) => <select id={id} disabled={saving || !semester} value={classId ?? ""} onChange={(event) => setClassId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">不分班</option>
          {semester?.classes.filter((group) =>
            (semester.is_active && group.is_active) || existing?.class_id === group.id
          ).map((group) => <option key={group.id} value={group.id}>{group.name}{group.is_active && semester.is_active ? "" : "（已归档）"}</option>)}
        </select>}</LabeledControl>
        {hasArchived && <p className="field-hint enrollment-rule">已归档的学期或班级只能保留现有分班或移出，不能再分入学生。</p>}
        {error && <div ref={errorRef} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
        <div className="modal-actions"><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={saving || !semester}>{saving ? "保存中…" : "保存"}</button></div>
      </form>
    </Modal>
  );
}

export function FieldModal({ title, label, note, initial, password = false, required = true, maxLength, onClose, onSubmit }: { title: string; label: string; note?: string; initial: string; password?: boolean; required?: boolean; maxLength?: number; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const noteId = useId();
  // One field: every error is about it, so focus goes back there to correct it.
  const errorRef = useFieldErrorFocus(error, inputRef);
  const close = () => { if (!saving) onClose(); };
  // Messages name the field without the rule in brackets ("新密码（至少 12 个字符）" → "新密码").
  const fieldName = label.replace(/（.*）$/, "");
  const submit = async () => {
    const validationError = studentFieldError(value, { label: fieldName, password, required, maxLength });
    if (validationError) {
      setError(validationError);
      inputRef.current?.focus();
      return;
    }
    await settleModalSubmission(
      () => onSubmit(password ? value : normalizeLabel(value)),
      onClose,
      setError,
      setSaving,
    );
  };
  const describedBy = [note ? noteId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <Modal title={title} onClose={close}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <LabeledControl label={label}>{(id) => <input ref={inputRef} id={id} name="student-field" disabled={saving} type={password ? "password" : "text"} autoComplete={password ? "new-password" : undefined} value={value} onChange={(event) => setValue(event.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} />}</LabeledControl>
      {note && <p id={noteId} className="field-hint">{note}</p>}
      {error && <div ref={errorRef} id={errorId} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
      <div className="modal-actions"><button type="button" disabled={saving} onClick={close}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
    </form></Modal>
  );
}
