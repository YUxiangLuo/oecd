import { useEffect, useId, useRef, useState } from "react";
import { LabeledControl } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import { showToast } from "../toast";
import type { AcademicSemester, ClassGroup } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { StudentBatchModal } from "./student-batch";
import { normalizeLabel } from "./text";
import { ConfirmModal, EmptyState, LoadFailure, Modal, StatusPill, Toolbar, useFieldErrorFocus } from "./ui";

type Editor =
  | { kind: "semester" }
  | { kind: "class"; semester: AcademicSemester }
  | { kind: "rename-semester"; semester: AcademicSemester }
  | { kind: "rename-class"; group: ClassGroup }
  | null;

export const ARCHIVE_SEMESTER_MESSAGE = "归档后不能再往这个学期加班级或学生。已有分班和实验记录都会保留，随时可以恢复。";
export const ARCHIVE_CLASS_MESSAGE = "归档后不能再往这个班导入或分配学生。该班学生的分班和实验记录都会保留，随时可以恢复。";

/** Semesters in use first (in the server's order), archived ones after them for the 历史学期 section. */
export function splitSemesters(semesters: readonly AcademicSemester[]) {
  return {
    active: semesters.filter((semester) => semester.is_active),
    archived: semesters.filter((semester) => !semester.is_active),
  };
}

export function SemestersTab() {
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<Editor>(null);
  const [batchClassId, setBatchClassId] = useState<number | null>(null);
  const { data, error, retry } = useAsync(() => api.classroom.semesters(), [refresh], { keepPreviousData: true });
  const semesters = data?.semesters ?? [];
  const { active, archived } = splitSemesters(semesters);
  const mutate = async (operation: Promise<unknown>) => {
    await operation;
    setRefresh((value) => value + 1);
  };
  // Archiving or restoring a semester moves its card between the two sections (and remounts it): once the
  // refreshed list shows the move, focus its archive button, or the closed 历史学期 summary that now holds it.
  const rootRef = useRef<HTMLDivElement>(null);
  const movedSemester = useRef<{ id: number; active: boolean } | null>(null);
  useEffect(() => {
    const moved = movedSemester.current;
    if (!moved || !semesters.some((semester) => semester.id === moved.id && semester.is_active === moved.active)) return;
    movedSemester.current = null;
    const card = rootRef.current?.querySelector<HTMLElement>(`[data-semester-id="${moved.id}"]`);
    const history = card?.closest("details");
    (history && !history.open ? history.querySelector<HTMLElement>("summary") : card?.querySelector<HTMLElement>(".semester-card-head .semester-archive-action button"))?.focus();
  }, [semesters]);

  if (error) return <LoadFailure what="学期与班级" error={error} onRetry={retry} />;
  const card = (semester: AcademicSemester) => (
    <section className={`semester-card${semester.is_active ? "" : " archived"}`} key={semester.id} data-semester-id={semester.id}>
      <header className="semester-card-head">
        <div className="semester-card-title">
          <div className="semester-title-row">
            <h3 className="clamp-2" title={semester.name}>{semester.name}</h3>
            <StatusPill tone={semester.is_active ? "ok" : "muted"}>
              {semester.is_active ? "使用中" : "已归档"}
            </StatusPill>
          </div>
          <p>{semester.student_count} 名学生 · {semester.classes.length} 个班级</p>
        </div>
        <div className="semester-actions">
          <button className="sm" aria-label={`重命名学期：${semester.name}`} onClick={() => setEditor({ kind: "rename-semester", semester })}>重命名</button>
          <ArchiveAction active={semester.is_active} kind="学期" name={semester.name} target={`学期：${semester.name}`}
            confirm={{ title: `归档学期“${semester.name}”？`, message: ARCHIVE_SEMESTER_MESSAGE }}
            onChange={async () => {
              await mutate(api.classroom.updateSemester(semester.id, { is_active: !semester.is_active }));
              movedSemester.current = { id: semester.id, active: !semester.is_active };
            }} />
        </div>
      </header>
      <div className="class-list">
        {semester.classes.map((group) => (
          <div className={`class-row${group.is_active ? "" : " archived"}`} key={group.id}>
            <div className="class-row-name">
              <div className="class-row-title">
                <b className="clamp-2" title={group.name}>{group.name}</b>
                {!group.is_active && <StatusPill tone="muted">已归档</StatusPill>}
              </div>
              <span className="class-count">{group.student_count} 名学生</span>
            </div>
            <div className="semester-actions">
              {semester.is_active && group.is_active && <button className="sm"
                aria-label={`批量导入学生：${semester.name} · ${group.name}`}
                onClick={() => setBatchClassId(group.id)}>批量导入学生</button>}
              <button className="sm" aria-label={`重命名班级：${semester.name} · ${group.name}`} onClick={() => setEditor({ kind: "rename-class", group })}>重命名</button>
              {/* Inside an archived semester a class can be neither used nor archived on its own. */}
              {semester.is_active && <ArchiveAction active={group.is_active} kind="班级" name={group.name}
                target={`班级：${semester.name} · ${group.name}`}
                confirm={{ title: `归档班级“${group.name}”？`, message: ARCHIVE_CLASS_MESSAGE }}
                onChange={() => mutate(api.classroom.updateClass(group.id, { is_active: !group.is_active }))} />}
            </div>
          </div>
        ))}
        {semester.classes.length === 0 && <p className="muted class-empty">这个学期还没有班级。</p>}
      </div>
      {semester.is_active ? (
        <button className="secondary semester-add-class" onClick={() => setEditor({ kind: "class", semester })}>
          + 新建班级
        </button>
      ) : <p className="muted archived-help">学期已归档。恢复后才能添加班级或分配学生。</p>}
    </section>
  );
  return (
    <div ref={rootRef}>
      <Toolbar>
        <p className="teacher-help">学期和班级只用来给学生分组，不会清空或复制学生的实验记录。</p>
        <div className="toolbar-actions">
          <button className="primary" onClick={() => setEditor({ kind: "semester" })}>+ 新建学期</button>
        </div>
      </Toolbar>
      {active.length > 0 && <div className="semester-grid">{active.map(card)}</div>}
      {/* Archived semesters stay out of the way; open when there is nothing else to show. */}
      {archived.length > 0 && (
        <details className="semester-history" open={active.length === 0}>
          <summary>历史学期（{archived.length}）</summary>
          <div className="semester-grid">{archived.map(card)}</div>
        </details>
      )}
      {data && semesters.length === 0 && (
        <EmptyState icon="🗓️" title="还没有学期" hint="先新建学期，再新建班级，然后给学生分班。" />
      )}
      {batchClassId !== null && <StudentBatchModal semesters={semesters} initialClassId={batchClassId}
        onClose={() => setBatchClassId(null)} onCreated={() => setRefresh((value) => value + 1)} />}
      {editor && (
        <NameModal
          title={editor.kind === "semester" ? "新建学期"
            : editor.kind === "class" ? `在“${editor.semester.name}”新建班级`
              : editor.kind === "rename-semester" ? "重命名学期" : "重命名班级"}
          label={editor.kind.includes("semester") ? "学期名称" : "班级名称"}
          initial={editor.kind === "rename-semester" ? editor.semester.name
            : editor.kind === "rename-class" ? editor.group.name : ""}
          onClose={() => setEditor(null)}
          onSubmit={async (name) => {
            if (editor.kind === "semester") {
              await mutate(api.classroom.createSemester(name));
              showToast(`已新建学期“${name}”`);
            } else if (editor.kind === "class") {
              await mutate(api.classroom.createClass(editor.semester.id, name));
              showToast(`已新建班级“${name}”`);
            } else if (editor.kind === "rename-semester") {
              await mutate(api.classroom.updateSemester(editor.semester.id, { name }));
              showToast(`已把学期重命名为“${name}”`);
            } else {
              await mutate(api.classroom.updateClass(editor.group.id, { name }));
              showToast(`已把班级重命名为“${name}”`);
            }
          }}
        />
      )}
    </div>
  );
}

function ArchiveAction({ active, kind, name, target, confirm, onChange }: {
  active: boolean;
  kind: "学期" | "班级";
  name: string;
  /** What is archived, for the button's accessible name ("归档学期：2026 秋"). */
  target: string;
  /** Ask before archiving (not before restoring). */
  confirm: { title: string; message: string };
  onChange: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const action = active ? "归档" : "恢复";
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onChange();
      showToast(active ? `已归档${kind}“${name}”（可随时恢复）` : `已恢复${kind}“${name}”`);
    } catch (cause) {
      setError(userFacingRequestError(cause, `${action}失败`));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="semester-archive-action">
      {/* aria-disabled, not disabled: a disabled button drops keyboard focus to the page while saving. */}
      <button className="sm" aria-disabled={saving || undefined} aria-label={`${action}${target}`}
        onClick={() => {
          if (saving) return;
          if (active) setConfirming(true);
          else void submit();
        }}>
        {saving ? `${action}中…` : action}
      </button>
      {error && <div className="error-box" role="alert">{error}</div>}
      {confirming && <ConfirmModal title={confirm.title} message={confirm.message} confirmLabel="归档"
        onConfirm={() => { void submit(); }} onClose={() => setConfirming(false)} />}
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
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  // Every error here is about the one field (blank, too long, a name already in use): focus goes back to it.
  const errorRef = useFieldErrorFocus(error, inputRef);
  const invalid = (message: string) => {
    setError(message);
    inputRef.current?.focus();
  };
  const submit = async () => {
    // Same normalization as the server, so what is checked here is what gets stored.
    const normalized = normalizeLabel(name);
    if (!normalized) return invalid(`${label}不能为空`);
    // Checked on the normalized text (as the server does); no maxLength on the input, which would count pasted
    // zero-width characters and cut a long name silently.
    if (normalized.length > 80) return invalid(`${label}不能超过 80 个字符（当前 ${normalized.length} 个）`);
    setSaving(true);
    setError(null);
    try {
      await onSubmit(normalized);
      onClose();
    } catch (cause) {
      setError(userFacingRequestError(cause, "保存失败"));
      setSaving(false);
    }
  };
  // No autoFocus here: Modal focuses the first field itself, and autoFocus made it lose the element to
  // return focus to when the dialog closes.
  return (
    <Modal title={title} onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <LabeledControl label={label}>{(id) => (
          <input ref={inputRef} id={id} disabled={saving} value={name} onChange={(event) => setName(event.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
        )}</LabeledControl>
        {error && <div ref={errorRef} id={errorId} className="error-box" role="alert" tabIndex={-1}>{error}</div>}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </Modal>
  );
}
