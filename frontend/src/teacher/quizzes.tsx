import { Fragment, useEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "../api";
import { sameJsonValue } from "../session-store";
import type { TeacherQuizBank, TeacherQuizQuestion } from "../types";
import { userFacingRequestError } from "../user-facing-error";
import { useTeacherReviewGuard } from "./review-guard";
import { ConfirmModal, LoadFailure } from "./ui";

const LEAVE = "理解题尚未保存，离开将丢失编辑内容。确定离开吗？";
const IMPACT = "保存后立即对系统所有学生生效，仅使当前步骤的旧答案失效；实验材料和已提交报告保留，未提交报告需重新生成。确定保存吗？";
const booleanOptions = () => [{ id: "true", label: "正确" }, { id: "false", label: "错误" }];
const choiceOptions = () => [{ id: "a", label: "" }, { id: "b", label: "" }];
const length = (value: string) => Array.from(value).length;
type Issue = { field: string; message: string };

function validate(questions: TeacherQuizQuestion[]): Issue | null {
  if (questions.length < 1 || questions.length > 3) return { field: "", message: "每步需要 1–3 道题。" };
  for (const [i, q] of questions.entries()) {
    const issue = (field: string, message: string) => ({ field: `${q.id}-${field}`, message: `第 ${i + 1} 题：${message}` });
    if (!q.prompt.trim() || length(q.prompt) > 500) return issue("prompt", "题干不能为空且最多 500 个字符。");
    if (q.options.length < 2 || q.options.length > 4) return issue("correct", "需要 2–4 个选项。");
    const seen = new Set<string>();
    for (const o of q.options) {
      if (!o.label.trim() || length(o.label) > 200) return issue(o.id, "选项不能为空且最多 200 个字符。");
      if (seen.has(o.label.trim())) return issue(o.id, "选项不能重复。");
      seen.add(o.label.trim());
    }
    if (!q.options.some((o) => o.id === q.correct)) return issue("correct", "请选择一个正确答案。");
    for (const field of ["hint", "explanation"] as const) {
      if (length(q[field]) > 1000) return issue(field, "提示和解析最多 1000 个字符。");
    }
  }
  return null;
}

const QUIZ_ERROR_ID = "teacher-quiz-error";
/** What a student sees after a wrong answer when the hint is left empty (gvcsim/quizzes.py grade). */
const DEFAULT_WRONG_FEEDBACK = "回答不正确，请重新阅读题目与选项后再试。";
const RESTORE_NOTE = "“恢复默认”把当前默认题目填进编辑区，点“保存并生效”后才生效。";

type QuizStep = TeacherQuizBank["steps"][number];
const pad = (value: number) => String(value).padStart(2, "0");
/** "2026-10-16 14:05" in the teacher's own time zone. */
function savedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * How a step's questions stand against the current defaults, one judgment for its button (`badge`) and the line
 * under its heading (`detail`): the defaults; a teacher's saved edit (who and when); or questions without a saver,
 * an older default set that the current defaults have since replaced.
 */
export function quizStepStatus(step: Pick<QuizStep, "is_default" | "updated_at" | "updated_by">): { badge: string; detail: string } {
  if (step.is_default) return { badge: "默认题目", detail: "默认题目" };
  if (step.updated_at) return { badge: "已自定义", detail: `已自定义（${step.updated_by ?? "教师"} ${savedAt(step.updated_at)}）` };
  return { badge: "与默认不同", detail: "与当前默认题目不同，可点“恢复默认”更新" };
}

export function QuizzesTab() {
  const [bank, setBank] = useState<TeacherQuizBank | null>(null);
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<TeacherQuizQuestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  /** The field a failed check pointed at: marked invalid and described by the message beside the save button. */
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; run: () => void } | null>(null);
  const form = useRef<HTMLFieldSetElement>(null);
  const busy = useRef(false);
  const guard = useTeacherReviewGuard();
  const current = bank?.steps.find((s) => s.step === step);
  // Stored questions come back with their keys in another order than the defaults: compare content, not spelling.
  const dirty = !!current && !sameJsonValue(draft, current.questions);
  // Share dirty and in-flight state with dashboard navigation and beforeunload.
  useEffect(() => { guard.publish({ dirty, saving, message: LEAVE }); }, [guard, dirty, saving]);
  useEffect(() => () => guard.clear(), [guard]);

  const load = async (selected = step) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    guard.publish({ dirty, saving: true, message: LEAVE });
    try {
      const next = await api.classroom.quizBank();
      setBank(next);
      const target = next.steps.find((s) => s.step === selected) ?? next.steps[0];
      if (target) { setStep(target.step); setDraft(structuredClone(target.questions)); }
      setConflict(false); setError(null); setNotice("");
    } catch (cause) { setError(userFacingRequestError(cause, "理解题加载失败")); }
    finally { busy.current = false; setSaving(false); }
  };
  useEffect(() => { void load(); }, []);

  const update = (id: string, patch: Partial<TeacherQuizQuestion>) => {
    setDraft((qs) => qs.map((q) => q.id === id ? { ...q, ...patch } : q));
    setError(null); setNotice(""); setInvalidField(null);
  };
  const fieldProps = (field: string) => ({
    "data-field": field,
    "aria-invalid": invalidField === field || undefined,
    "aria-describedby": invalidField === field && error ? QUIZ_ERROR_ID : undefined,
  });
  /** The message of a failed check, right under the field it points at (the save button can be far below). */
  const fieldError = (field: string) => invalidField === field && error
    ? <p id={QUIZ_ERROR_ID} className="quiz-field-error" role="alert">{error}</p>
    : null;
  const save = async () => {
    if (busy.current || !current) return;
    busy.current = true; setSaving(true);
    guard.publish({ dirty, saving: true, message: LEAVE });
    try {
      const next = await api.classroom.saveQuizStep(step, { version: current.version, questions: draft });
      setBank(next); setDraft(structuredClone(next.steps.find((s) => s.step === step)!.questions));
      setConflict(false); setError(null); setNotice("已保存并生效。");
    } catch (cause) {
      setConflict(isApiErrorStatus(cause, 409));
      setError(userFacingRequestError(cause, "保存失败"));
    } finally { busy.current = false; setSaving(false); }
  };
  const requestSave = () => {
    if (saving || !dirty || conflict) return;
    const issue = validate(draft);
    if (issue) {
      setError(issue.message);
      setInvalidField(issue.field);
      const field = Array.from(form.current?.querySelectorAll<HTMLElement>("[data-field]") ?? []).find((element) => element.dataset.field === issue.field);
      field?.focus(); field?.scrollIntoView?.({ block: "center" });
      return;
    }
    // A field marked by an earlier check may be gone (its question deleted): a later server error must show itself.
    setInvalidField(null);
    setConfirmation({ title: "保存并生效", message: IMPACT, run: () => { void save(); } });
  };
  if (!bank) return error ? <LoadFailure what="理解题" error={error} onRetry={() => { void load(); }} /> : <p role="status">正在加载理解题…</p>;
  return <div className="teacher-quizzes">
    <p className="tipbox">步骤 1–14 为系统统一题库，不按班级配置。每步 1–3 道判断题或单选题。{IMPACT.split("确定保存吗？")[0]}{RESTORE_NOTE}</p>
    <div className="toolbar" aria-label="理解题步骤列表">
      {bank.steps.filter((s) => s.step >= 1 && s.step <= 14).map((s) => <button key={s.step} disabled={saving} aria-current={step === s.step ? "step" : undefined}
        onClick={() => { if (s.step !== step) guard.attempt(() => { setStep(s.step); setDraft(structuredClone(s.questions)); setConflict(false); setError(null); setNotice(""); setInvalidField(null); }); }}>
        {s.step}. {s.title} · {s.questions.length} 题 · {quizStepStatus(s).badge}
      </button>)}
    </div>
    <h3>步骤 {step} · {current?.title}</h3>
    {current && <p>{quizStepStatus(current).detail}</p>}
    <fieldset ref={form} disabled={saving} className="quiz-editor">
      <legend className="sr-only">理解题编辑</legend>
      {draft.map((q, i) => <section key={q.id} className="teacher-quiz-card" aria-label={`第 ${i + 1} 题`}>
        <div className="toolbar"><b>第 {i + 1} 题</b>
          <button disabled={i === 0} onClick={() => setDraft((qs) => { const next = [...qs]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; return next; })}>上移</button>
          <button disabled={i === draft.length - 1} onClick={() => setDraft((qs) => { const next = [...qs]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; return next; })}>下移</button>
          <button disabled={draft.length <= 1} onClick={() => setDraft((qs) => qs.filter((v) => v.id !== q.id))}>删除题目</button>
        </div>
        <label>题型<select value={q.kind} onChange={(e) => {
          const kind = e.target.value as TeacherQuizQuestion["kind"];
          setConfirmation({ title: "切换题型", message: "切换将清空旧选项和正确答案，确定继续吗？", run: () => update(q.id, { kind, options: kind === "true_false" ? booleanOptions() : choiceOptions(), correct: "" }) });
        }}><option value="single_choice">单选题</option><option value="true_false">判断题</option></select></label>
        <label>题干（最多 500 字）<textarea {...fieldProps(`${q.id}-prompt`)} value={q.prompt} onChange={(e) => update(q.id, { prompt: e.target.value })} /></label>
        {fieldError(`${q.id}-prompt`)}
        {q.options.map((o, oi) => <Fragment key={o.id}><div className="teacher-quiz-option">
          <label>选项 {oi + 1}<input {...fieldProps(`${q.id}-${o.id}`)} value={o.label} readOnly={q.kind === "true_false"} onChange={(e) => update(q.id, { options: q.options.map((v) => v.id === o.id ? { ...v, label: e.target.value } : v) })} /></label>
          {q.kind === "single_choice" && <button disabled={q.options.length <= 2} onClick={() => update(q.id, { options: q.options.filter((v) => v.id !== o.id), correct: q.correct === o.id ? "" : q.correct })}>删除选项 {oi + 1}</button>}
        </div>{fieldError(`${q.id}-${o.id}`)}</Fragment>)}
        {q.kind === "single_choice" && <button disabled={q.options.length >= 4} onClick={() => {
          const id = ["a", "b", "c", "d"].find((v) => !q.options.some((o) => o.id === v))!;
          update(q.id, { options: [...q.options, { id, label: "" }] });
        }}>添加选项</button>}
        <label>正确答案<select {...fieldProps(`${q.id}-correct`)} value={q.correct} onChange={(e) => update(q.id, { correct: e.target.value })}>
          <option value="">请选择</option>{q.options.map((o, oi) => <option key={o.id} value={o.id}>{oi + 1}. {o.label}</option>)}
        </select></label>
        {fieldError(`${q.id}-correct`)}
        <label>提示（最多 1000 字）<textarea {...fieldProps(`${q.id}-hint`)} value={q.hint} onChange={(e) => update(q.id, { hint: e.target.value })} /></label>
        {fieldError(`${q.id}-hint`)}
        <label>解析（最多 1000 字）<textarea {...fieldProps(`${q.id}-explanation`)} value={q.explanation} onChange={(e) => update(q.id, { explanation: e.target.value })} /></label>
        {fieldError(`${q.id}-explanation`)}
      </section>)}
      {error && !conflict && (invalidField
        ? <p className="quiz-save-blocked">没有保存：请先修改上方标红的内容。</p>
        : <div className="error-box" role="alert">{error}</div>)}
      {notice && <p role="status">{notice}</p>}
      {conflict && <p role="alert">版本冲突，编辑内容已保留。需要保留的内容请先复制，再<button disabled={saving} onClick={() => setConfirmation({ title: "载入最新题库", message: "载入最新将丢弃当前编辑内容，确定继续吗？", run: () => { void load(); } })}>载入最新</button></p>}
      <div className="toolbar">
        <button disabled={draft.length >= 3} onClick={() => setDraft((qs) => [...qs, { id: crypto.randomUUID(), kind: "single_choice", prompt: "", options: choiceOptions(), correct: "", hint: "", explanation: "" }])}>添加题目</button>
        <button onClick={() => {
          const defaults = current?.defaults ?? [];
          setDraft(structuredClone(defaults)); setError(null); setInvalidField(null);
          setNotice(current && sameJsonValue(defaults, current.questions) ? "本步当前就是默认题目，无需保存。" : "已把当前默认题目填进编辑区，点“保存并生效”后才生效。");
        }}>恢复默认</button>
        <button className="primary" disabled={!dirty || conflict} onClick={requestSave}>{saving ? "正在保存…" : "保存并生效"}</button>
      </div>
    </fieldset>
    <section aria-label="学生预览" className="teacher-quiz-preview"><h3>学生预览</h3>
      <p className="muted">学生页面不标出正确选项；提交后逐题显示反馈：答错的题显示“提示”，答对的题显示“解析”，如下。</p>
      {draft.map((q, i) => <fieldset key={q.id}><legend>{i + 1}. 【{q.kind === "true_false" ? "判断题" : "单选题"}】{q.prompt}</legend><div className="quiz-options">{q.options.map((o) => <label key={o.id}><input type="radio" name={`preview-${q.id}`} value={o.id} disabled={saving} />{o.label}</label>)}</div>
        {/* The feedback as the student page words it (step-quiz.tsx): a bold verdict, then the hint or the explanation. */}
        <dl className="teacher-quiz-feedback">
          <dt>答错时显示</dt><dd><b>回答有误。</b>{q.hint.trim() || DEFAULT_WRONG_FEEDBACK}</dd>
          <dt>答对后显示</dt><dd><b>回答正确。</b>{q.explanation.trim() || <span className="muted">（未填解析）</span>}</dd>
        </dl>
      </fieldset>)}
    </section>
    {confirmation && <ConfirmModal title={confirmation.title} message={confirmation.message} onConfirm={confirmation.run} onClose={() => setConfirmation(null)} />}
  </div>;
}
