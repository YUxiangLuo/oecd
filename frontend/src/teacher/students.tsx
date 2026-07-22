import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { ClassInfo, StepsResponse, StudentRow } from "../types";
import { ConfirmModal, EmptyState, Modal, SearchInput, StatusPill, Toolbar } from "./ui";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

type ModalState =
  | null
  | { type: "class" }
  | { type: "student" }
  | { type: "rename"; s: StudentRow }
  | { type: "password"; s: StudentRow }
  | { type: "toggle"; s: StudentRow };

/** 班级与学生:工具条(筛选/搜索/建班/建号) + 进度表 + 模态编辑 */
type SortKey = "max_step" | "verified_completed_count" | "score" | "last_login_at";

type StudentStepFilterKind = "reached" | "completed";
export const PASSWORD_INPUT_PROPS = { type: "password", autoComplete: "new-password" } as const;
export function filterStudentsByStep(students: StudentRow[], step: number | null, kind: StudentStepFilterKind): StudentRow[] {
  if (step == null) return students;
  return kind === "completed"
    ? students.filter((student) => student.verified_completed_steps?.includes(step))
    : students.filter((student) => (student.max_step ?? 0) >= step);
}

export function StudentsTab({ initialClassId, filteredStep, filterKind, onClearStep }: {
  initialClassId: number | null;
  filteredStep: number | null;
  filterKind: StudentStepFilterKind;
  onClearStep: () => void;
}) {
  const [classId, setClassId] = useState<number | null>(initialClassId);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: cls } = useAsync<{ classes: ClassInfo[] }>(() => api.classroom.classes(), [refresh]);
  const { data: stepsData } = useAsync<StepsResponse>(() => api.steps(), []);
  const { data, error } = useAsync<{ students: StudentRow[] }>(
    () => api.classroom.students(classId),
    [classId, refresh],
  );

  const run = (p: Promise<unknown>) =>
    p.then(
      () => {
        setActionError(null);
        setRefresh((n) => n + 1);
      },
      (e) => setActionError(String(e.message ?? e)),
    );

  if (error) return <div className="error-box">{error}</div>;

  const all = data?.students ?? [];
  const q = query.trim().toLowerCase();
  const searched = q
    ? all.filter((s) =>
        [s.display_name, s.username, s.student_no].some((v) => (v ?? "").toLowerCase().includes(q)),
      )
    : all;
  const reached = filterStudentsByStep(searched, filteredStep, filterKind);
  const students = sort
    ? [...reached].sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      })
    : reached;
  const stepTitles = new Map((stepsData?.steps ?? []).map((s) => [s.n, s.title]));
  const toggleSort = (key: SortKey) => setSort((current) => (
    current?.key === key
      ? { key, dir: current.dir === "desc" ? "asc" : "desc" }
      : { key, dir: "desc" }
  ));
  const sortMark = (key: SortKey) => sort?.key === key ? (sort.dir === "desc" ? " ↓" : " ↑") : "";

  return (
    <div>
      <Toolbar>
        <div className="field">
          <label>班级</label>
          <select value={classId ?? ""} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">全部班级</option>
            {(cls?.classes ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}({c.student_count ?? 0} 人)
              </option>
            ))}
          </select>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="搜索姓名 / 用户名 / 学号" />
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => setModal({ type: "class" })}>
            + 新建班级
          </button>
          <button className="primary" onClick={() => setModal({ type: "student" })}>
            + 添加学生
          </button>
        </div>
      </Toolbar>

      {filteredStep != null && (
        <div className="active-filter">
          已筛选：{filterKind === "completed" ? "已完成" : "最远到达"}步骤 {filteredStep} · {stepTitles.get(filteredStep) ?? ""}
          <button onClick={onClearStep}>清除</button>
        </div>
      )}

      {actionError && <div className="error-box">{actionError}</div>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>用户名</th>
              <th>学号</th>
              <th>班级</th>
              <th>当前步</th>
              <th><button className="table-sort" onClick={() => toggleSort("max_step")}>到达位置{sortMark("max_step")}</button></th>
              <th><button className="table-sort" onClick={() => toggleSort("verified_completed_count")}>完成步骤{sortMark("verified_completed_count")}</button></th>
              <th>完成状态</th>
              <th>报告</th>
              <th><button className="table-sort" onClick={() => toggleSort("score")}>得分{sortMark("score")}</button></th>
              <th><button className="table-sort" onClick={() => toggleSort("last_login_at")}>最近登录{sortMark("last_login_at")}</button></th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id} className={s.active ? undefined : "row-disabled"}>
                <td>{s.display_name}</td>
                <td className="mono">{s.username}</td>
                <td>{s.student_no || "—"}</td>
                <td>{s.class_name ?? "—"}</td>
                <td title={s.current_step ? stepTitles.get(s.current_step) : undefined}>
                  {s.current_step ? `${s.current_step} · ${stepTitles.get(s.current_step) ?? ""}` : "—"}
                </td>
                <td>
                  {s.max_step ? (
                    <span className="step-cell">
                      <span className="mini-track">
                        <span className="mini-bar" style={{ width: `${(s.max_step / 16) * 100}%` }} />
                      </span>
                      {s.max_step}/16
                    </span>
                  ) : (
                    <span className="muted">未开始</span>
                  )}
                </td>
                <td>
                  <span className="step-cell" title={`已完成步骤：${(s.verified_completed_steps ?? []).join("、") || "无"}`}>
                    <span className="mini-track verified">
                      <span className="mini-bar" style={{ width: `${((s.verified_completed_count ?? 0) / 16) * 100}%` }} />
                    </span>
                    {s.verified_completed_count ?? 0}/16
                  </span>
                </td>
                <td>
                  {s.legacy_unverified ? (
                    <StatusPill tone="warn">旧会话不可用</StatusPill>
                  ) : s.session_stale ? (
                    <StatusPill tone="warn">数据版本已过期</StatusPill>
                  ) : (s.verified_completed_count ?? 0) > 0 ? (
                    <StatusPill tone="ok">服务端已判定</StatusPill>
                  ) : (
                    <StatusPill tone="muted">尚无完成步骤</StatusPill>
                  )}
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>
                    有效活动 {fmtTime(s.last_valid_activity)}
                  </div>
                </td>
                <td>
                  {s.submission_state === "graded" ? (
                    <StatusPill tone="ok">已评阅</StatusPill>
                  ) : s.submission_state === "pending" ? (
                    <StatusPill tone="warn">待评阅</StatusPill>
                  ) : (
                    <StatusPill tone="muted">未提交</StatusPill>
                  )}
                </td>
                <td>{s.score ?? "—"}</td>
                <td>{fmtTime(s.last_login_at)}</td>
                <td>
                  {s.active ? <StatusPill tone="info">正常</StatusPill> : <StatusPill tone="muted">已停用</StatusPill>}
                </td>
                <td>
                  <details className="row-menu">
                    <summary aria-label="操作">⋯</summary>
                    <div className="row-menu-pop">
                      <button onClick={(e) => (closeMenu(e), setModal({ type: "rename", s }))}>改名</button>
                      <button onClick={(e) => (closeMenu(e), setModal({ type: "password", s }))}>重置密码</button>
                      <button
                        className={s.active ? "danger" : undefined}
                        onClick={(e) => (closeMenu(e), setModal({ type: "toggle", s }))}
                      >
                        {s.active ? "停用" : "启用"}
                      </button>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {students.length === 0 && (
          <EmptyState
            icon="👥"
            title={all.length ? "没有匹配的学生" : "暂无学生"}
            hint={all.length ? "换个关键词试试" : "点击「添加学生」创建第一个账号"}
            action={
              all.length ? undefined : (
                <button className="primary" onClick={() => setModal({ type: "student" })}>
                  + 添加学生
                </button>
              )
            }
          />
        )}
      </div>
      <p className="muted panel-note">“到达位置”只表示浏览导航；步骤 1–15 由答题通过判定，第 16 步由报告生成判定。停用账号会立即撤销现有会话并禁止后续请求，但保留历史记录。</p>

      {modal?.type === "class" && (
        <ClassModal onClose={() => setModal(null)} onSubmit={(b) => run(api.classroom.createClass(b))} />
      )}
      {modal?.type === "student" && (
        <StudentModal
          classes={cls?.classes ?? []}
          defaultClassId={classId}
          onClose={() => setModal(null)}
          onSubmit={(b) => run(api.classroom.createStudent(b))}
        />
      )}
      {modal?.type === "rename" && (
        <FieldModal
          title="修改姓名"
          label="姓名"
          initial={modal.s.display_name}
          validate={(v) => (v.trim() ? null : "姓名不能为空")}
          onClose={() => setModal(null)}
          onSubmit={(v) => run(api.classroom.updateStudent(modal.s.id, { display_name: v.trim() }))}
        />
      )}
      {modal?.type === "password" && (
        <FieldModal
          title={`重置 ${modal.s.display_name} 的密码`}
          label="新密码"
          initial=""
          inputType="password"
          autoComplete="new-password"
          validate={(v) => (v.length >= 12 ? null : "密码至少 12 位")}
          onClose={() => setModal(null)}
          onSubmit={(v) => run(api.classroom.updateStudent(modal.s.id, { password: v }))}
        />
      )}
      {modal?.type === "toggle" && (
        <ConfirmModal
          title={modal.s.active ? "停用账号" : "启用账号"}
          message={`确定要${modal.s.active ? "停用" : "启用"} ${modal.s.display_name}(${modal.s.username})吗?`}
          confirmLabel={modal.s.active ? "停用" : "启用"}
          danger={modal.s.active}
          onConfirm={() => run(api.classroom.updateStudent(modal.s.id, { active: !modal.s.active }))}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

const closeMenu = (e: React.MouseEvent) => {
  const d = (e.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null;
  if (d) d.open = false;
};

function ClassModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (b: { name: string; code: string; semester?: string }) => void;
}) {
  const [f, setF] = useState({ name: "", code: "", semester: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="新建班级" onClose={onClose}>
      <div className="modal-form">
        <label>班级名称</label>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="如:GVC 实验 A 班" />
        <label>班级代码</label>
        <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="如:GVC-2026-A" />
        <label>学期(可空)</label>
        <input value={f.semester} onChange={(e) => setF({ ...f, semester: e.target.value })} placeholder="如:2026 春" />
        {err && <div className="error-box">{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              if (!f.name || !f.code) return setErr("班级名称与代码必填");
              onSubmit(f);
              onClose();
            }}
          >
            创建班级
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StudentModal({
  classes,
  defaultClassId,
  onClose,
  onSubmit,
}: {
  classes: ClassInfo[];
  defaultClassId: number | null;
  onClose: () => void;
  onSubmit: (b: {
    username: string;
    display_name: string;
    password: string;
    student_no: string;
    class_id: number | null;
  }) => void;
}) {
  const [f, setF] = useState({ username: "", display_name: "", password: "", student_no: "" });
  const [classChoice, setClassChoice] = useState(defaultClassId == null ? "" : String(defaultClassId));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="添加学生账号" onClose={onClose}>
      <div className="modal-form">
        <label>用户名(登录用)</label>
        <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="字母数字下划线" />
        <label>姓名</label>
        <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        <label>学号(可空)</label>
        <input value={f.student_no} onChange={(e) => setF({ ...f, student_no: e.target.value })} />
        <label>初始密码(≥12 位)</label>
        <input {...PASSWORD_INPUT_PROPS} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <label>所属班级</label>
        <select value={classChoice} onChange={(e) => setClassChoice(e.target.value)}>
          {defaultClassId == null && <option value="">请选择班级</option>}
          <option value="unassigned">暂不分班</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {err && <div className="error-box">{err}</div>}
        <p className="muted">创建后学生即可使用该账号登录；在“全部班级”视图中必须明确选择归属。</p>
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              if (!f.username || !f.display_name || f.password.length < 12)
                return setErr("请填写用户名、姓名,密码至少 12 位");
              if (!classChoice) return setErr("请选择所属班级，或明确选择“暂不分班”");
              onSubmit({ ...f, class_id: classChoice === "unassigned" ? null : Number(classChoice) });
              onClose();
            }}
          >
            创建账号
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FieldModal({
  title,
  label,
  initial,
  inputType = "text",
  autoComplete,
  validate,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  initial: string;
  inputType?: "text" | "password";
  autoComplete?: string;
  validate: (v: string) => string | null;
  onClose: () => void;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose} width={380}>
      <div className="modal-form">
        <label>{label}</label>
        <input type={inputType} autoComplete={autoComplete} autoFocus value={v} onChange={(e) => setV(e.target.value)} />
        {err && <div className="error-box">{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              const msg = validate(v);
              if (msg) return setErr(msg);
              onSubmit(v);
              onClose();
            }}
          >
            确定
          </button>
        </div>
      </div>
    </Modal>
  );
}
