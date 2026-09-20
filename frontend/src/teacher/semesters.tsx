import { useState } from "react";
import { LabeledControl } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AcademicSemester, ClassGroup } from "../types";
import { EmptyState, Modal, StatusPill, Toolbar } from "./ui";

type Editor =
  | { kind: "semester" }
  | { kind: "class"; semester: AcademicSemester }
  | { kind: "rename-semester"; semester: AcademicSemester }
  | { kind: "rename-class"; group: ClassGroup }
  | null;

export function SemestersTab() {
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<Editor>(null);
  const { data, error } = useAsync(() => api.classroom.semesters(), [refresh]);
  const semesters = data?.semesters ?? [];
  const mutate = async (operation: Promise<unknown>) => {
    await operation;
    setRefresh((value) => value + 1);
  };

  if (error) return <div className="error-box" role="alert">{error}</div>;
  return (
    <div>
      <Toolbar>
        <p className="teacher-help">学期和班级只用于教师端分组，不会清空或复制学生的实验记录。</p>
        <div className="toolbar-actions">
          <button className="primary" onClick={() => setEditor({ kind: "semester" })}>+ 新建学期</button>
        </div>
      </Toolbar>
      <div className="semester-grid">
        {semesters.map((semester) => (
          <section className={`semester-card${semester.is_active ? "" : " archived"}`} key={semester.id}>
            <header className="semester-card-head">
              <div>
                <div className="semester-title-row">
                  <h3>{semester.name}</h3>
                  <StatusPill tone={semester.is_active ? "ok" : "muted"}>
                    {semester.is_active ? "使用中" : "已归档"}
                  </StatusPill>
                </div>
                <p>{semester.student_count} 名学生 · {semester.classes.length} 个班级</p>
              </div>
              <div className="semester-actions">
                <button className="sm" onClick={() => setEditor({ kind: "rename-semester", semester })}>重命名</button>
                <button
                  className="sm"
                  onClick={() => { void mutate(api.classroom.updateSemester(semester.id, { is_active: !semester.is_active })); }}
                >
                  {semester.is_active ? "归档" : "恢复"}
                </button>
              </div>
            </header>
            <div className="class-list">
              {semester.classes.map((group) => (
                <div className="class-row" key={group.id}>
                  <div>
                    <b>{group.name}</b>
                    <span>{group.student_count} 名学生{group.is_active ? "" : " · 已归档"}</span>
                  </div>
                  <div className="semester-actions">
                    <button className="sm" onClick={() => setEditor({ kind: "rename-class", group })}>重命名</button>
                    <button
                      className="sm"
                      onClick={() => { void mutate(api.classroom.updateClass(group.id, { is_active: !group.is_active })); }}
                    >
                      {group.is_active ? "归档" : "恢复"}
                    </button>
                  </div>
                </div>
              ))}
              {semester.classes.length === 0 && <p className="muted class-empty">这个学期还没有班级。</p>}
            </div>
            {semester.is_active ? (
              <button className="secondary semester-add-class" onClick={() => setEditor({ kind: "class", semester })}>
                + 添加班级
              </button>
            ) : <p className="muted archived-help">恢复学期后才能添加班级或分配学生。</p>}
          </section>
        ))}
      </div>
      {semesters.length === 0 && (
        <EmptyState icon="🗓️" title="还没有学期" hint="先创建学期，再在学期下添加班级并给学生分班。" />
      )}
      {editor && (
        <NameModal
          title={editor.kind === "semester" ? "新建学期"
            : editor.kind === "class" ? `在 ${editor.semester.name} 添加班级`
              : editor.kind === "rename-semester" ? "重命名学期" : "重命名班级"}
          label={editor.kind.includes("semester") ? "学期名称" : "班级名称"}
          initial={editor.kind === "rename-semester" ? editor.semester.name
            : editor.kind === "rename-class" ? editor.group.name : ""}
          onClose={() => setEditor(null)}
          onSubmit={async (name) => {
            if (editor.kind === "semester") await mutate(api.classroom.createSemester(name));
            else if (editor.kind === "class") await mutate(api.classroom.createClass(editor.semester.id, name));
            else if (editor.kind === "rename-semester") await mutate(api.classroom.updateSemester(editor.semester.id, { name }));
            else await mutate(api.classroom.updateClass(editor.group.id, { name }));
          }}
        />
      )}
    </div>
  );
}

export function NameModal({ title, label, initial, onClose, onSubmit }: {
  title: string;
  label: string;
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const normalized = name.trim();
    if (!normalized) return setError(`${label}不能为空`);
    setSaving(true);
    setError(null);
    try {
      await onSubmit(normalized);
      onClose();
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
      setSaving(false);
    }
  };
  return (
    <Modal title={title} onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <LabeledControl label={label}>{(id) => (
          <input id={id} autoFocus disabled={saving} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        )}</LabeledControl>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </Modal>
  );
}
