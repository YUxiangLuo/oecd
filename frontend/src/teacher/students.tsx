import { useEffect, useId, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AcademicSemester, StudentRow } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { AcademicFilters, matchesAcademicFilter, enrollmentLabel } from "./academic-filter";
import { normalizeLabel, stripInvisibleEdges } from "./text";
import { EmptyState, LoadFailure, Modal, SearchInput, StatusPill, Toolbar, useModalErrorFocus, useRefetchOnVisible } from "./ui";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";
// No maxLength on password fields: a pasted longer password would be cut silently (it is masked) and the
// handed-out password would not work. studentFieldError says so instead.
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_INPUT_PROPS = { type: "password", autoComplete: "new-password" } as const;
export const VALID_ACTIVITY_HINT = "最近一次保存实验记录、生成或提交报告的时间（仅登录或浏览不计）";

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

/** The create form's first problem, checked as the server will (usernames and 学号 are compared exactly, so trimmed). */
export function newStudentError(student: NewStudent): string | null {
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(stripInvisibleEdges(student.username))) return "用户名须为 2–40 位字母、数字、下划线、点或连字符";
  return studentFieldError(student.display_name, { label: "姓名", maxLength: STUDENT_NAME_MAX_LENGTH })
    ?? studentFieldError(student.student_no, { label: "学号", required: false, maxLength: STUDENT_NO_MAX_LENGTH })
    ?? studentFieldError(student.password, { label: "初始密码", password: true });
}

type ModalState = null | { type: "student" } | { type: "name" | "student_no" | "password" | "enrollment"; student: StudentRow };

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
  const passwordLabel = student.demo_seed ? "固定演示口令" : "重置密码";
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
      <summary aria-label={`操作：${who}`}>⋯</summary>
      <div className="row-menu-pop">
        <button aria-label={`修改姓名：${who}`} onClick={(event) => pick(event, "name")}>修改姓名</button>
        <button aria-label={`修改学号：${who}`} onClick={(event) => pick(event, "student_no")}>修改学号</button>
        <button aria-label={`调整班级：${who}`} onClick={(event) => pick(event, "enrollment")}>调整班级</button>
        <span title={student.demo_seed ? "演示账号的密码由系统统一管理；如需演示改密，请新建普通学生账号" : undefined}>
          <button
            disabled={student.demo_seed}
            aria-label={`${passwordLabel}：${who}`}
            onClick={(event) => pick(event, "password")}
          >
            {passwordLabel}
          </button>
        </span>
      </div>
    </details>
  );
}

export function StudentsTab() {
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
  const [modal, setModal] = useState<ModalState>(null);
  // Keep the table while it reloads after an edit: clearing it flashed "暂无学生" and lost the scroll position.
  const { data, error, status, retry } = useAsync<{ students: StudentRow[] }>(() => api.classroom.students(), [refresh], { keepPreviousData: true });
  // Progress changes during class: refresh when the teacher comes back to this tab (not while a dialog is open).
  useRefetchOnVisible(() => setRefresh((value) => value + 1), modal == null);
  const { data: academic, error: academicError, retry: retryAcademic } = useAsync(() => api.classroom.semesters(), [refresh], { keepPreviousData: true });

  const run = async (operation: Promise<unknown>) => {
    await operation;
    setRefresh((value) => value + 1);
  };

  if (error || academicError) {
    return <LoadFailure what="学生列表" error={(error ?? academicError)!} onRetry={() => {
      if (error) retry();
      if (academicError) retryAcademic();
    }} />;
  }
  const all = data?.students ?? [];
  const semesters = academic?.semesters ?? [];
  // Normalized like stored names (full-width letters/digits, zero-width characters), then case-folded.
  const needle = normalizeLabel(query).toLowerCase();
  const students = all
    .filter((student) => matchesAcademicFilter(student.enrollments, semesterId, classId))
    .filter((student) => !needle || [student.display_name, student.username, student.student_no]
      .some((value) => normalizeLabel(value ?? "").toLowerCase().includes(needle)));

  return (
    <div>
      <Toolbar>
        <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名 / 用户名 / 学号" />
        <AcademicFilters
          semesters={semesters}
          semesterId={semesterId}
          classId={classId}
          onSemesterChange={setSemesterId}
          onClassChange={setClassId}
        />
        <div className="toolbar-actions">
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>刷新列表</button>
          <button className="primary" onClick={() => setModal({ type: "student" })}>+ 添加学生</button>
        </div>
      </Toolbar>
      {/* The previous rows stay while a refresh loads; say so, since they may be a moment out of date. */}
      <p className="muted list-refreshing" role="status">{data && status === "loading" ? "正在刷新列表…" : ""}</p>
      <p id={activityHintId} className="sr-only">有效活动：{VALID_ACTIVITY_HINT}</p>
      <ScrollableRegion className="table-wrap student-table-scroll" label="学生进度表，可横向及纵向滚动">
        <table className="data-table">
          <thead><tr><th>姓名</th><th>用户名</th><th>学号</th><th>班级</th><th>完成步骤</th><th>报告</th><th>得分</th>
            <th className="th-hint" title={VALID_ACTIVITY_HINT} aria-describedby={activityHintId}>有效活动</th>
            <th>最近登录</th><th>操作</th></tr></thead>
          <tbody>
            {students.map((student) => (
              <tr key={student.id}>
                <td className="student-name-cell">{student.display_name}</td>
                <td className="mono">{student.username}</td>
                <td className="student-no-cell" title={student.student_no || undefined}>{student.student_no || "—"}</td>
                <td className="class-memberships">{student.enrollments.length
                  ? student.enrollments.map((item) => <span key={item.term_id}>{enrollmentLabel(item, semesters)}</span>)
                  : "未分班"}</td>
                <td title={`已完成步骤：${student.verified_completed_steps.join("、") || "无"}`}>
                  <span className="step-cell"><span className="mini-track verified"><span className="mini-bar" style={{ width: `${student.verified_completed_count / student.verified_total_steps * 100}%` }} /></span>{student.verified_completed_count}/{student.verified_total_steps}</span>
                </td>
                <td>{student.report_state === "graded" ? <StatusPill tone="ok">已评阅</StatusPill> : student.report_state === "pending" ? <StatusPill tone="warn">待评阅</StatusPill> : student.report_state === "draft" ? <StatusPill tone="muted">草稿</StatusPill> : <StatusPill tone="muted">未生成</StatusPill>}</td>
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
            ? (needle || semesterId != null || classId != null ? "清除搜索或分组筛选后重试" : "换个关键词试试")
            : "点击添加学生创建账号"}
        />}
      </ScrollableRegion>

      {modal?.type === "student" && <StudentModal semesters={semesters} onClose={() => setModal(null)} onSubmit={(body) => run(api.classroom.createStudent(body))} />}
      {modal?.type === "enrollment" && (
        <EnrollmentModal
          student={modal.student}
          semesters={semesters}
          onClose={() => setModal(null)}
          onSubmit={(termId, nextClassId) => run(api.classroom.setEnrollment(modal.student.id, termId, nextClassId))}
        />
      )}
      {modal && modal.type !== "student" && (
        modal.type !== "enrollment" &&
        <FieldModal
          title={modal.type === "name" ? `修改 ${modal.student.display_name} 的姓名`
            : modal.type === "student_no" ? `修改 ${modal.student.display_name} 的学号` : `重置 ${modal.student.display_name} 的密码`}
          label={modal.type === "name" ? "姓名" : modal.type === "student_no" ? "学号" : "新密码"}
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

export function StudentModal({ semesters = [], onClose, onSubmit }: { semesters?: AcademicSemester[]; onClose: () => void; onSubmit: (body: { username: string; display_name: string; password: string; student_no: string; class_id?: number }) => Promise<void> }) {
  const [form, setForm] = useState<{ username: string; display_name: string; password: string; student_no: string; class_id?: number }>({ username: "", display_name: "", password: "", student_no: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorRef = useModalErrorFocus(error);
  const close = () => { if (!saving) onClose(); };
  const submit = async () => {
    const body = {
      ...form,
      username: stripInvisibleEdges(form.username),
      display_name: normalizeLabel(form.display_name),
      student_no: normalizeLabel(form.student_no),
    };
    const problem = newStudentError(body);
    if (problem) {
      setError(problem);
      return;
    }
    await settleModalSubmission(() => onSubmit(body), onClose, setError, setSaving);
  };
  return (
    <Modal title="添加学生账号" onClose={close}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <LabeledControl label="用户名（登录用，2–40 位字母、数字、_ . -）">{(id) => <input id={id} name="student-username" disabled={saving} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />}</LabeledControl>
      <LabeledControl label="姓名">{(id) => <input id={id} name="student-display-name" disabled={saving} value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />}</LabeledControl>
      <LabeledControl label="学号（可空）">{(id) => <input id={id} name="student-number" disabled={saving} value={form.student_no} onChange={(event) => setForm({ ...form, student_no: event.target.value })} />}</LabeledControl>
      <LabeledControl label="初始班级（可空）">{(id) => <select id={id} disabled={saving} value={form.class_id ?? ""} onChange={(event) => setForm({ ...form, class_id: event.target.value ? Number(event.target.value) : undefined })}>
        <option value="">暂不分班</option>
        {semesters.filter((semester) => semester.is_active).map((semester) => <optgroup key={semester.id} label={semester.name}>
          {semester.classes.filter((group) => group.is_active).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </optgroup>)}
      </select>}</LabeledControl>
      <LabeledControl label="初始密码（至少 12 个字符）">{(id) => <input id={id} name="student-password" disabled={saving} {...PASSWORD_INPUT_PROPS} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />}</LabeledControl>
      {error && <div ref={errorRef} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
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
  const submit = async () => {
    if (termId == null) return setError("请先创建并选择学期");
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
          {availableSemesters.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_active ? "" : "（已归档，仅可移出）"}</option>)}
        </select>}</LabeledControl>
        <LabeledControl label="班级">{(id) => <select id={id} disabled={saving || !semester} value={classId ?? ""} onChange={(event) => setClassId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">未分班（移出该学期班级）</option>
          {semester?.classes.filter((group) =>
            (semester.is_active && group.is_active) || existing?.class_id === group.id
          ).map((group) => <option key={group.id} value={group.id}>{group.name}{group.is_active && semester.is_active ? "" : "（已归档，仅保留现有归属）"}</option>)}
        </select>}</LabeledControl>
        {error && <div ref={errorRef} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
        <div className="modal-actions"><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={saving || !semester}>{saving ? "保存中…" : "保存"}</button></div>
      </form>
    </Modal>
  );
}

export function FieldModal({ title, label, initial, password = false, required = true, maxLength, onClose, onSubmit }: { title: string; label: string; initial: string; password?: boolean; required?: boolean; maxLength?: number; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorRef = useModalErrorFocus(error);
  const close = () => { if (!saving) onClose(); };
  const submit = async () => {
    const validationError = studentFieldError(value, { label, password, required, maxLength });
    if (validationError) return setError(validationError);
    await settleModalSubmission(
      () => onSubmit(password ? value : normalizeLabel(value)),
      onClose,
      setError,
      setSaving,
    );
  };
  return (
    <Modal title={title} onClose={close}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <LabeledControl label={label}>{(id) => <input id={id} name="student-field" disabled={saving} type={password ? "password" : "text"} autoComplete={password ? "new-password" : undefined} value={value} onChange={(event) => setValue(event.target.value)} />}</LabeledControl>
      {error && <div ref={errorRef} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
      <div className="modal-actions"><button type="button" disabled={saving} onClick={close}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
    </form></Modal>
  );
}
