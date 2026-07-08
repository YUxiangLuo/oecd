import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { ClassInfo, StudentRow } from "../types";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

/** 班级与学生:建班、建号、进度矩阵、编辑/停用 */
export function StudentsTab() {
  const [classId, setClassId] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: cls } = useAsync<{ classes: ClassInfo[] }>(() => api.classroom.classes(), [refresh]);
  const { data, error } = useAsync<{ students: StudentRow[] }>(
    () => api.classroom.students(classId),
    [classId, refresh],
  );

  const [form, setForm] = useState({ username: "", display_name: "", password: "", student_no: "" });
  const [classForm, setClassForm] = useState({ name: "", code: "", semester: "" });
  const [showClassForm, setShowClassForm] = useState(false);

  const run = (p: Promise<unknown>) =>
    p.then(
      () => { setActionError(null); setRefresh((n) => n + 1); },
      (e) => setActionError(String(e.message ?? e)),
    );

  const addStudent = () => {
    if (!form.username || !form.display_name || form.password.length < 6) {
      setActionError("请填写用户名、姓名,密码至少 6 位");
      return;
    }
    run(api.classroom.createStudent({ ...form, class_id: classId ?? cls?.classes[0]?.id ?? null })).then(() =>
      setForm({ username: "", display_name: "", password: "", student_no: "" }),
    );
  };

  const resetPassword = (s: StudentRow) => {
    const pw = window.prompt(`为 ${s.display_name}(${s.username})设置新密码(至少 6 位):`);
    if (pw) run(api.classroom.updateStudent(s.id, { password: pw }));
  };

  const rename = (s: StudentRow) => {
    const name = window.prompt("修改姓名:", s.display_name);
    if (name) run(api.classroom.updateStudent(s.id, { display_name: name }));
  };

  if (error) return <div className="error-box">{error}</div>;
  return (
    <div>
      <div className="controls">
        <label>班级</label>
        <select value={classId ?? ""} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">全部班级</option>
          {(cls?.classes ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}({c.student_count ?? 0} 人)</option>
          ))}
        </select>
        <button className="secondary" onClick={() => setShowClassForm((v) => !v)}>
          {showClassForm ? "收起建班" : "+ 新建班级"}
        </button>
      </div>

      {showClassForm && (
        <div className="controls inline-form">
          <input placeholder="班级名称" value={classForm.name} onChange={(e) => setClassForm({ ...classForm, name: e.target.value })} />
          <input placeholder="班级代码(如 GVC-2026-B)" value={classForm.code} onChange={(e) => setClassForm({ ...classForm, code: e.target.value })} />
          <input placeholder="学期(可空)" value={classForm.semester} onChange={(e) => setClassForm({ ...classForm, semester: e.target.value })} />
          <button
            className="primary"
            onClick={() => {
              if (!classForm.name || !classForm.code) { setActionError("班级名称与代码必填"); return; }
              run(api.classroom.createClass(classForm)).then(() => setClassForm({ name: "", code: "", semester: "" }));
            }}
          >
            创建班级
          </button>
        </div>
      )}

      <div className="section-head"><span className="section-head-icon">➕</span>添加学生账号<span className="section-head-line" /></div>
      <div className="controls inline-form">
        <input placeholder="用户名(登录用)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input placeholder="姓名" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        <input placeholder="学号(可空)" value={form.student_no} onChange={(e) => setForm({ ...form, student_no: e.target.value })} />
        <input placeholder="初始密码(≥6位)" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <button className="primary" onClick={addStudent}>创建账号</button>
        <span className="muted">归入{classId ? "当前所选班级" : "默认班级"};创建后学生即可用该账号登录</span>
      </div>
      {actionError && <div className="error-box">{actionError}</div>}

      <div className="section-head"><span className="section-head-icon">👥</span>学生名单与实验进度<span className="section-head-line" /></div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>姓名</th><th>用户名</th><th>学号</th><th>班级</th>
              <th>当前步</th><th>最远步</th><th>报告</th><th>得分</th>
              <th>最近登录</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.students ?? []).map((s) => (
              <tr key={s.id} style={s.active ? undefined : { opacity: 0.5 }}>
                <td>{s.display_name}</td>
                <td>{s.username}</td>
                <td>{s.student_no || "—"}</td>
                <td>{s.class_name ?? "—"}</td>
                <td>{s.current_step ?? "—"}</td>
                <td>
                  {s.max_step ? (
                    <span>
                      {s.max_step}/17
                      <span className="mini-track"><span className="mini-bar" style={{ width: `${(s.max_step / 17) * 100}%` }} /></span>
                    </span>
                  ) : "未开始"}
                </td>
                <td>{s.submission_state === "graded" ? "已评阅" : s.submission_state === "pending" ? "待评阅" : "未提交"}</td>
                <td>{s.score ?? "—"}</td>
                <td>{fmtTime(s.last_login_at)}</td>
                <td>{s.active ? "正常" : "已停用"}</td>
                <td className="row-actions">
                  <button onClick={() => rename(s)}>改名</button>
                  <button onClick={() => resetPassword(s)}>重置密码</button>
                  <button onClick={() => run(api.classroom.updateStudent(s.id, { active: !s.active }))}>
                    {s.active ? "停用" : "启用"}
                  </button>
                </td>
              </tr>
            ))}
            {data && data.students.length === 0 && (
              <tr><td colSpan={11} className="muted">暂无学生,请先用上方表单创建账号。</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">停用只禁止后续登录(已发令牌 12 小时内自然过期),不删除数据;进度由学生端自动上报。</p>
    </div>
  );
}
