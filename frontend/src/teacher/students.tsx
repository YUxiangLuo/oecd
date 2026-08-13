import { useState } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { StudentRow } from "../types";
import { EmptyState, Modal, SearchInput, StatusPill, Toolbar } from "./ui";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";
export const PASSWORD_INPUT_PROPS = { type: "password", autoComplete: "new-password" } as const;

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
    setError(String((cause as Error).message ?? cause));
    return false;
  } finally {
    setSaving(false);
  }
}

export function studentFieldError(
  value: string,
  { label, password = false, required = true }: { label: string; password?: boolean; required?: boolean },
) {
  if (password && value.length < 12) return "密码至少 12 位";
  if (!password && required && !value.trim()) return `${label}不能为空`;
  return null;
}

type ModalState = null | { type: "student" } | { type: "name" | "student_no" | "password"; student: StudentRow };

export function StudentsTab() {
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const { data, error } = useAsync<{ students: StudentRow[] }>(() => api.classroom.students(), [refresh]);

  const run = async (operation: Promise<unknown>) => {
    await operation;
    setRefresh((value) => value + 1);
  };

  if (error) return <div className="error-box">{error}</div>;
  const all = data?.students ?? [];
  const needle = query.trim().toLowerCase();
  const students = needle
    ? all.filter((student) => [student.display_name, student.username, student.student_no]
        .some((value) => (value ?? "").toLowerCase().includes(needle)))
    : all;

  return (
    <div>
      <Toolbar>
        <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名 / 用户名 / 学号" />
        <div className="toolbar-actions">
          <button className="primary" onClick={() => setModal({ type: "student" })}>+ 添加学生</button>
        </div>
      </Toolbar>
      <ScrollableRegion className="table-wrap" label="学生进度表，可横向滚动">
        <table className="data-table">
          <thead><tr><th>姓名</th><th>用户名</th><th>学号</th><th>完成步骤</th><th>报告</th><th>得分</th><th>有效活动</th><th>最近登录</th><th /></tr></thead>
          <tbody>
            {students.map((student) => (
              <tr key={student.id}>
                <td>{student.display_name}</td>
                <td className="mono">{student.username}</td>
                <td>{student.student_no || "—"}</td>
                <td title={`已完成步骤：${student.verified_completed_steps.join("、") || "无"}`}>
                  <span className="step-cell"><span className="mini-track verified"><span className="mini-bar" style={{ width: `${student.verified_completed_count / 16 * 100}%` }} /></span>{student.verified_completed_count}/16</span>
                </td>
                <td>{student.report_state === "graded" ? <StatusPill tone="ok">已评阅</StatusPill> : student.report_state === "pending" ? <StatusPill tone="warn">待评阅</StatusPill> : student.report_state === "draft" ? <StatusPill tone="muted">草稿</StatusPill> : <StatusPill tone="muted">未生成</StatusPill>}</td>
                <td>{student.score ?? "—"}</td>
                <td>{fmtTime(student.last_valid_activity)}</td>
                <td>{fmtTime(student.last_login_at)}</td>
                <td>
                  <details className="row-menu"><summary aria-label="操作">⋯</summary><div className="row-menu-pop">
                    <button onClick={() => setModal({ type: "name", student })}>修改姓名</button>
                    <button onClick={() => setModal({ type: "student_no", student })}>修改学号</button>
                    <button onClick={() => setModal({ type: "password", student })}>重置密码</button>
                  </div></details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {students.length === 0 && <EmptyState icon="👥" title={all.length ? "没有匹配的学生" : "暂无学生"} hint={all.length ? "换个关键词试试" : "点击添加学生创建账号"} />}
      </ScrollableRegion>

      {modal?.type === "student" && <StudentModal onClose={() => setModal(null)} onSubmit={(body) => run(api.classroom.createStudent(body))} />}
      {modal && modal.type !== "student" && (
        <FieldModal
          title={modal.type === "name" ? "修改姓名" : modal.type === "student_no" ? "修改学号" : `重置 ${modal.student.display_name} 的密码`}
          label={modal.type === "name" ? "姓名" : modal.type === "student_no" ? "学号" : "新密码"}
          initial={modal.type === "name" ? modal.student.display_name : modal.type === "student_no" ? modal.student.student_no : ""}
          password={modal.type === "password"}
          required={modal.type !== "student_no"}
          onClose={() => setModal(null)}
          onSubmit={(value) => run(api.classroom.updateStudent(modal.student.id, { [modal.type === "name" ? "display_name" : modal.type]: value }))}
        />
      )}
    </div>
  );
}

export function StudentModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (body: { username: string; display_name: string; password: string; student_no: string }) => Promise<void> }) {
  const [form, setForm] = useState({ username: "", display_name: "", password: "", student_no: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => { if (!saving) onClose(); };
  const submit = async () => {
    if (!form.username || !form.display_name || form.password.length < 12) {
      setError("请填写用户名、姓名和至少 12 位的密码");
      return;
    }
    await settleModalSubmission(() => onSubmit(form), onClose, setError, setSaving);
  };
  return (
    <Modal title="添加学生账号" onClose={close}><div className="modal-form">
      <LabeledControl label="用户名（登录用）">{(id) => <input id={id} name="student-username" disabled={saving} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />}</LabeledControl>
      <LabeledControl label="姓名">{(id) => <input id={id} name="student-display-name" disabled={saving} value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />}</LabeledControl>
      <LabeledControl label="学号（可空）">{(id) => <input id={id} name="student-number" disabled={saving} value={form.student_no} onChange={(event) => setForm({ ...form, student_no: event.target.value })} />}</LabeledControl>
      <LabeledControl label="初始密码（至少 12 位）">{(id) => <input id={id} name="student-password" disabled={saving} {...PASSWORD_INPUT_PROPS} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />}</LabeledControl>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button disabled={saving} onClick={close}>取消</button><button className="primary" disabled={saving} onClick={submit}>{saving ? "创建中…" : "创建账号"}</button></div>
    </div></Modal>
  );
}

export function FieldModal({ title, label, initial, password = false, required = true, onClose, onSubmit }: { title: string; label: string; initial: string; password?: boolean; required?: boolean; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => { if (!saving) onClose(); };
  const submit = async () => {
    const validationError = studentFieldError(value, { label, password, required });
    if (validationError) return setError(validationError);
    await settleModalSubmission(
      () => onSubmit(password ? value : value.trim()),
      onClose,
      setError,
      setSaving,
    );
  };
  return (
    <Modal title={title} onClose={close}><div className="modal-form">
      <LabeledControl label={label}>{(id) => <input id={id} name="student-field" disabled={saving} type={password ? "password" : "text"} autoComplete={password ? "new-password" : undefined} value={value} onChange={(event) => setValue(event.target.value)} />}</LabeledControl>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button disabled={saving} onClick={close}>取消</button><button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存"}</button></div>
    </div></Modal>
  );
}
