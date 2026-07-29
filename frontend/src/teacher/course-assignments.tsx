import { useEffect, useMemo, useState } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import { showToast } from "../toast";
import type { Assignment, CourseRun, EnrollmentRow, Meta, StudentRow } from "../types";
import { activeEnrollmentAccountIds, assignmentMatchesManifest, buildAssignmentPayload, type AssignmentDraft } from "./course-model";
import { ConfirmModal, EmptyState, Modal, SearchInput, StatusPill, Toolbar } from "./ui";

const fmtTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "不限";
const initialCourse = () => ({ name: "", code: "", term: "", releaseTag: "" });
const localDateKey = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10).replaceAll("-", "");
};
const initialAssignment = (): AssignmentDraft & { active: boolean } => ({
  slug: `lab-${localDateKey()}`,
  title: "全球价值链实证分析",
  releaseTag: "",
  opensAt: "",
  dueAt: "",
  active: true,
});

type Dialog = "course" | "assignment" | null;

/** 教师真实发布链路：course run → manifest-frozen assignment → enrollment。 */
export function CourseAssignmentsTab() {
  const [refresh, setRefresh] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [courseForm, setCourseForm] = useState(initialCourse);
  const [assignmentForm, setAssignmentForm] = useState(initialAssignment);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAssignment, setPendingAssignment] = useState<Assignment | null>(null);
  const [pendingRunArchive, setPendingRunArchive] = useState<CourseRun | null>(null);
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState<Set<number>>(new Set());

  const { data: meta, error: metaError } = useAsync<Meta>(() => api.meta(), []);
  const { data: runsData, error: runsError } = useAsync<{ course_runs: CourseRun[] }>(
    () => api.classroom.courseRuns(),
    [refresh],
  );
  const runs = runsData?.course_runs ?? [];
  useEffect(() => {
    if (selectedRunId == null && runs.length) setSelectedRunId((runs.find((run) => !run.archived) ?? runs[0]).id);
  }, [runs, selectedRunId]);
  useEffect(() => {
    setSelectedStudents(new Set());
  }, [selectedRunId]);

  const { data: assignmentData, error: assignmentError } = useAsync<{ assignments: Assignment[] }>(
    () => selectedRunId == null ? Promise.resolve({ assignments: [] }) : api.classroom.assignments(selectedRunId),
    [selectedRunId, refresh],
  );
  const { data: studentData, error: studentError } = useAsync<{ students: StudentRow[] }>(
    () => api.classroom.students(),
    [refresh],
  );
  const { data: enrollmentData, error: enrollmentError } = useAsync<{ enrollments: EnrollmentRow[] }>(
    () => selectedRunId == null ? Promise.resolve({ enrollments: [] }) : api.classroom.enrollments(selectedRunId),
    [selectedRunId, refresh],
  );
  const assignments = assignmentData?.assignments ?? [];
  const currentManifest = meta?.manifest_id ?? null;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const activeMatchingAssignments = assignments.filter((assignment) =>
    assignment.active && assignmentMatchesManifest(assignment, currentManifest));
  const enrolledAccountIds = activeEnrollmentAccountIds(enrollmentData?.enrollments ?? []);

  const visibleStudents = useMemo(() => {
    const query = studentQuery.trim().toLowerCase();
    return (studentData?.students ?? []).filter((student) => !query
      || [student.display_name, student.username, student.student_no, student.class_name]
        .some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [studentData, studentQuery]);

  const closeDialog = () => {
    if (saving) return;
    setDialog(null);
    setActionError(null);
  };

  const createCourse = async () => {
    const name = courseForm.name.trim();
    const code = courseForm.code.trim();
    if (!name || !code) return setActionError("课程名称和运行代码必填。");
    if (!/^[a-zA-Z0-9_.-]+$/.test(code)) return setActionError("运行代码只能包含字母、数字、点、下划线和连字符。");
    setSaving(true);
    setActionError(null);
    try {
      const created = await api.classroom.createCourseRun({
        name,
        code,
        term: courseForm.term.trim(),
        release_tag: courseForm.releaseTag.trim(),
      });
      setSelectedRunId(created.id);
      setCourseForm(initialCourse());
      setDialog(null);
      setRefresh((value) => value + 1);
      showToast(`已创建课程运行 ${created.code}`);
    } catch (cause) {
      setActionError(String((cause as Error).message ?? cause));
    } finally {
      setSaving(false);
    }
  };

  const createAssignment = async () => {
    if (!selectedRunId || !currentManifest) return setActionError("当前课程运行或服务器 manifest 未就绪。");
    const payload = buildAssignmentPayload(assignmentForm, selectedRunId, currentManifest);
    if (!payload.slug || !payload.title) return setActionError("作业标题和 slug 必填。");
    if (!/^[a-zA-Z0-9_.-]+$/.test(payload.slug)) return setActionError("作业 slug 只能包含字母、数字、点、下划线和连字符。");
    if (payload.opens_at && payload.due_at && payload.due_at <= payload.opens_at) return setActionError("截止时间必须晚于开放时间。");
    setSaving(true);
    setActionError(null);
    try {
      const created = await api.classroom.createAssignment(payload);
      if (!assignmentForm.active) await api.classroom.setAssignmentState(created.id, false);
      setAssignmentForm(initialAssignment());
      setDialog(null);
      setRefresh((value) => value + 1);
      showToast(`作业 ${created.slug} 已绑定当前 manifest`);
    } catch (cause) {
      setActionError(String((cause as Error).message ?? cause));
    } finally {
      setSaving(false);
    }
  };

  const toggleAssignment = async (assignment: Assignment) => {
    setActionError(null);
    try {
      await api.classroom.setAssignmentState(assignment.id, !assignment.active);
      setRefresh((value) => value + 1);
      showToast(assignment.active ? "作业已停用" : "作业已激活");
    } catch (cause) {
      setActionError(String((cause as Error).message ?? cause));
    }
  };

  const toggleRunArchive = async (run: CourseRun) => {
    setActionError(null);
    try {
      await api.classroom.archiveCourseRun(run.id, !run.archived);
      setRefresh((value) => value + 1);
      showToast(run.archived ? "课程运行已恢复" : "课程运行已归档");
    } catch (cause) {
      setActionError(String((cause as Error).message ?? cause));
    }
  };

  const enrollSelected = async () => {
    if (!selectedRunId || !selectedStudents.size) return;
    setSaving(true);
    setActionError(null);
    let completed = 0;
    try {
      for (const accountId of selectedStudents) {
        const student = (studentData?.students ?? []).find((item) => item.id === accountId);
        await api.classroom.enrollStudent({
          course_run_id: selectedRunId,
          account_id: accountId,
          class_id: student?.class_id ?? null,
        });
        completed += 1;
      }
      setSelectedStudents(new Set());
      setRefresh((value) => value + 1);
      showToast(`已将 ${completed} 名学生加入 ${selectedRun?.code ?? "课程运行"}`);
    } catch (cause) {
      setActionError(`已成功 ${completed} 人；随后操作失败：${String((cause as Error).message ?? cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const error = runsError ?? metaError;
  if (error) return <div className="error-box">{error}</div>;

  return (
    <div className="course-publish-page">
      <div className="publish-flow" role="list" aria-label="作业发布流程">
        <div className={selectedRun ? "done" : ""} role="listitem"><b>1</b><span>课程运行<small>{selectedRun ? selectedRun.code : "待创建"}</small></span></div>
        <div className={activeMatchingAssignments.length ? "done" : ""} role="listitem"><b>2</b><span>冻结并开放作业<small>{activeMatchingAssignments.length ? `${activeMatchingAssignments.length} 个当前版本作业` : "待发布"}</small></span></div>
        <div className={enrolledAccountIds.size ? "done" : ""} role="listitem"><b>3</b><span>加入学生<small>{enrolledAccountIds.size ? `已加入 ${enrolledAccountIds.size} 人` : "选择学生"}</small></span></div>
      </div>

      <Toolbar>
        <div className="field">
          <LabeledControl label="课程运行">
            {(id) => (
              <select id={id} value={selectedRunId ?? ""} onChange={(event) => setSelectedRunId(Number(event.target.value))}>
                {!runs.length && <option value="">尚无课程运行</option>}
                {runs.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.code}{run.archived ? "（已归档）" : ""}</option>)}
              </select>
            )}
          </LabeledControl>
        </div>
        <div className="toolbar-actions">
          {selectedRun && (
            <button type="button" className={selectedRun.archived ? "secondary" : "danger"} onClick={() => setPendingRunArchive(selectedRun)}>
              {selectedRun.archived ? "恢复课程运行" : "归档课程运行"}
            </button>
          )}
          <button type="button" className="primary" onClick={() => { setCourseForm(initialCourse()); setActionError(null); setDialog("course"); }}>＋ 新建课程运行</button>
        </div>
      </Toolbar>

      {actionError && <div className="error-box" style={{ marginBottom: 14 }}>{actionError}</div>}
      {!runsData ? <p className="muted">正在读取课程运行…</p> : !selectedRun ? (
        <EmptyState icon="🏫" title="还没有课程运行" hint="先创建一个学期/班次对应的 course run，再发布作业。" action={<button className="primary" onClick={() => setDialog("course")}>创建课程运行</button>} />
      ) : (
        <div className="panel-grid course-publish-grid">
          <section className="panel wide">
            <div className="panel-head">
              <span className="panel-ic">📦</span>作业与数据版本
              <span className="panel-tag">当前 manifest：{currentManifest ? currentManifest.slice(0, 12) : "不可用"}</span>
              <button
                type="button"
                className="primary sm panel-head-action"
                disabled={selectedRun.archived || !currentManifest}
                onClick={() => { setAssignmentForm(initialAssignment()); setActionError(null); setDialog("assignment"); }}
              >＋ 发布作业</button>
            </div>
            <p className="panel-note muted">作业会冻结到创建时的 artifact manifest。学生只会进入最新创建、已开放且已激活的作业；换数据版本必须新建作业，不能静默改绑。</p>
            {assignmentError && <div className="error-box">{assignmentError}</div>}
            {!assignmentData ? <p className="muted">加载中…</p> : assignments.length === 0 ? (
              <EmptyState icon="🧪" title="此课程运行还没有作业" hint="点击“发布作业”，系统会自动绑定当前服务器数据版本。" />
            ) : (
              <ScrollableRegion className="table-wrap" label="课程作业表，可横向滚动">
                <table className="data-table assignment-table">
                  <thead><tr><th>作业</th><th>数据版本</th><th>开放 / 截止</th><th>状态</th><th>操作</th></tr></thead>
                  <tbody>{assignments.map((assignment) => {
                    const matches = assignmentMatchesManifest(assignment, currentManifest);
                    return (
                      <tr key={assignment.id}>
                        <td><b>{assignment.title}</b><div className="muted">{assignment.slug}{assignment.release_tag ? ` · ${assignment.release_tag}` : ""}</div></td>
                        <td><code title={assignment.manifest_id}>{assignment.manifest_id.slice(0, 12)}</code><div><StatusPill tone={matches ? "ok" : "warn"}>{matches ? "当前版本" : "历史版本"}</StatusPill></div></td>
                        <td><div>{fmtTime(assignment.opens_at)}</div><div className="muted">至 {fmtTime(assignment.due_at)}</div></td>
                        <td><StatusPill tone={assignment.active ? "ok" : "muted"}>{assignment.active ? "已激活" : "已停用"}</StatusPill></td>
                        <td><button
                          type="button"
                          className={`sm ${assignment.active ? "danger" : "secondary"}`}
                          disabled={!assignment.active && !matches}
                          title={!assignment.active && !matches ? "历史 manifest 作业不能重新激活" : undefined}
                          onClick={() => setPendingAssignment(assignment)}
                        >{assignment.active ? "停用" : "激活"}</button></td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </ScrollableRegion>
            )}
          </section>

          <section className="panel wide">
            <div className="panel-head"><span className="panel-ic">👥</span>将学生加入 {selectedRun.code}<span className="panel-tag">已选 {selectedStudents.size} 人</span></div>
            <p className="panel-note muted">Enrollment 只建立课程归属；学生首次进入一个已激活、已开放且 manifest 匹配的作业时，服务器才为其创建 attempt。重复加入同一学生会安全地恢复/更新 enrollment。</p>
            {activeMatchingAssignments.length === 0 && <div className="warnbox" style={{ margin: "10px 0" }}>当前没有与服务器 manifest 匹配的激活作业。可以先加入学生，但学生端会保持锁定，直到你发布并激活匹配作业。</div>}
            <Toolbar>
              <SearchInput value={studentQuery} onChange={setStudentQuery} placeholder="搜索姓名 / 学号 / 班级" />
              <div className="toolbar-actions">
                <button type="button" className="secondary" disabled={!visibleStudents.length} onClick={() => setSelectedStudents(new Set(visibleStudents.map((student) => student.id)))}>选择当前列表</button>
                <button type="button" className="primary" disabled={saving || selectedRun.archived || !selectedStudents.size} onClick={() => void enrollSelected()}>{saving ? "正在加入…" : `加入 ${selectedStudents.size} 名学生`}</button>
              </div>
            </Toolbar>
            {(studentError || enrollmentError) && <div className="error-box">{studentError ?? enrollmentError}</div>}
            {!studentData ? <p className="muted">正在读取学生…</p> : visibleStudents.length === 0 ? (
              <EmptyState icon="👤" title="没有可加入的学生账号" hint="先在“班级与学生”页创建学生，再回到这里加入课程运行。" />
            ) : (
              <div className="enrollment-list">
                {visibleStudents.map((student) => {
                  const selected = selectedStudents.has(student.id);
                  const enrolled = enrolledAccountIds.has(student.id);
                  return (
                    <label key={student.id} className={`enrollment-row${selected ? " selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => setSelectedStudents((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(student.id); else next.delete(student.id);
                          return next;
                        })}
                      />
                      <span><b>{student.display_name}</b><small>{student.student_no || student.username} · {student.class_name ?? "未分班"}</small></span>
                      <StatusPill tone={enrolled ? "ok" : "muted"}>{enrolled ? "已加入此 run" : "未加入"}</StatusPill>
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {dialog === "course" && (
        <Modal title="新建课程运行" onClose={closeDialog} width={500}>
          <div className="modal-form">
            <LabeledControl label="课程运行名称 *">
              {(id) => <input id={id} value={courseForm.name} onChange={(event) => setCourseForm({ ...courseForm, name: event.target.value })} placeholder="例如：全球价值链分析 2026 秋" />}
            </LabeledControl>
            <LabeledControl label="运行代码 *">
              {(id) => <input id={id} value={courseForm.code} onChange={(event) => setCourseForm({ ...courseForm, code: event.target.value })} placeholder="例如：GVC-2026-FALL" />}
            </LabeledControl>
            <LabeledControl label="学期">
              {(id) => <input id={id} value={courseForm.term} onChange={(event) => setCourseForm({ ...courseForm, term: event.target.value })} placeholder="2026 秋" />}
            </LabeledControl>
            <LabeledControl label="发布标签">
              {(id) => <input id={id} value={courseForm.releaseTag} onChange={(event) => setCourseForm({ ...courseForm, releaseTag: event.target.value })} placeholder="可选，如 cohort-a" />}
            </LabeledControl>
            {actionError && <div className="error-box" style={{ marginBottom: 12 }}>{actionError}</div>}
            <button type="button" className="primary block" disabled={saving} onClick={() => void createCourse()}>{saving ? "创建中…" : "创建并选中"}</button>
          </div>
        </Modal>
      )}

      {dialog === "assignment" && selectedRun && (
        <Modal title={`向 ${selectedRun.code} 发布作业`} onClose={closeDialog} width={540}>
          <div className="modal-form">
            <div className="manifest-lock-note"><b>🔒 数据版本自动冻结</b><code>{currentManifest ?? "manifest 不可用"}</code><span>此字段来自当前服务器，教师不能手填或改写。</span></div>
            <LabeledControl label="作业标题 *">
              {(id) => <input id={id} value={assignmentForm.title} onChange={(event) => setAssignmentForm({ ...assignmentForm, title: event.target.value })} />}
            </LabeledControl>
            <LabeledControl label="作业 slug *">
              {(id) => <input id={id} value={assignmentForm.slug} onChange={(event) => setAssignmentForm({ ...assignmentForm, slug: event.target.value })} />}
            </LabeledControl>
            <LabeledControl label="发布标签">
              {(id) => <input id={id} value={assignmentForm.releaseTag} onChange={(event) => setAssignmentForm({ ...assignmentForm, releaseTag: event.target.value })} placeholder="可选" />}
            </LabeledControl>
            <div className="assignment-date-grid">
              <label>开放时间<input type="datetime-local" value={assignmentForm.opensAt} onChange={(event) => setAssignmentForm({ ...assignmentForm, opensAt: event.target.value })} /></label>
              <label>截止时间<input type="datetime-local" value={assignmentForm.dueAt} onChange={(event) => setAssignmentForm({ ...assignmentForm, dueAt: event.target.value })} /></label>
            </div>
            <label className="modal-check"><input type="checkbox" checked={assignmentForm.active} onChange={(event) => setAssignmentForm({ ...assignmentForm, active: event.target.checked })} />创建后立即激活</label>
            {actionError && <div className="error-box" style={{ marginBottom: 12 }}>{actionError}</div>}
            <button type="button" className="primary block" disabled={saving || !currentManifest} onClick={() => void createAssignment()}>{saving ? "发布中…" : "绑定当前 manifest 并发布"}</button>
          </div>
        </Modal>
      )}

      {pendingAssignment && (
        <ConfirmModal
          title={pendingAssignment.active ? "停用作业" : "激活作业"}
          message={pendingAssignment.active
            ? <>停用 <b>{pendingAssignment.title}</b> 后，尚未进入的学生将无法获得该作业上下文；已有 attempt 与审计记录会保留。</>
            : <>激活 <b>{pendingAssignment.title}</b> 后，它可能成为学生最新的开放作业。确认其时间和 manifest 无误。</>}
          confirmLabel={pendingAssignment.active ? "确认停用" : "确认激活"}
          danger={pendingAssignment.active}
          onConfirm={() => void toggleAssignment(pendingAssignment)}
          onClose={() => setPendingAssignment(null)}
        />
      )}
      {pendingRunArchive && (
        <ConfirmModal
          title={pendingRunArchive.archived ? "恢复课程运行" : "归档课程运行"}
          message={pendingRunArchive.archived
            ? <>恢复 <b>{pendingRunArchive.name}</b> 后，其中已激活作业可再次成为学生上下文。</>
            : <>归档 <b>{pendingRunArchive.name}</b> 会阻止其中作业继续成为学生上下文；既有 enrollment、attempt、提交和评分不会删除。</>}
          confirmLabel={pendingRunArchive.archived ? "确认恢复" : "确认归档"}
          danger={!pendingRunArchive.archived}
          onConfirm={() => void toggleRunArchive(pendingRunArchive)}
          onClose={() => setPendingRunArchive(null)}
        />
      )}
    </div>
  );
}
