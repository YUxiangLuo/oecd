import { useEffect, useMemo, useRef, useState } from "react";
import { api, isApiErrorStatus } from "./api";
import { MATERIAL_STATUS_LABELS, STEP_MATERIAL_ACTION_ID, type StepMaterialStatus } from "./step-task-card";
import type { QuizCompletionState, Step, StepStateApi } from "./types";
import { userFacingRequestError } from "./user-facing-error";

export type QuizDraftStore = Map<number, { version: string; answers: Record<string, string>; stale?: boolean }>;

interface QuizFeedback {
  question_id: string;
  correct: boolean;
  explanation: string;
}

interface QuizPanelProps {
  step: Step;
  draftStore?: QuizDraftStore;
  materialStatus?: StepMaterialStatus;
  onRecordMaterials?: () => void;
  state: StepStateApi<Record<string, unknown>>;
  /** The step after this one: once the quiz is done, the panel's main action moves on to it. */
  next?: Pick<Step, "n" | "title">;
  onNavigate?: (step: number) => void;
  onRefresh?: () => Promise<void>;
}

/** 步骤 1–14 的唯一完成条件：答对本步当前版本的全部理解题。 */
export function QuizPanel(props: QuizPanelProps) {
  // A step without a quiz renders nothing; the body's hooks then never run conditionally.
  return props.step.quiz ? <QuizPanelBody {...props} quiz={props.step.quiz} /> : null;
}

function QuizPanelBody({
  step,
  quiz,
  state,
  draftStore,
  materialStatus,
  onRecordMaterials,
  next,
  onNavigate,
  onRefresh,
}: QuizPanelProps & { quiz: NonNullable<Step["quiz"]> }) {
  const data = state.data as (QuizCompletionState & Record<string, unknown>) | undefined;
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<QuizFeedback[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The workspace-owned draft survives step navigation, but never crosses accounts.
  const knownStale = draftStore?.get(step.n)?.version === quiz.version && draftStore?.get(step.n)?.stale === true;
  const [stale, setStale] = useState(knownStale);
  const currentVersion = useRef(quiz.version);
  currentVersion.current = quiz.version;
  useEffect(() => {
    setFeedback([]);
    setError(null);
    setStale(draftStore?.get(step.n)?.version === quiz.version && draftStore?.get(step.n)?.stale === true);
  }, [quiz.version, step.n, draftStore]);
  const savedAnswers = useMemo(() => {
    if (!quiz || data?.quiz?.version !== quiz.version) return {};
    return data.quiz.answers ?? {};
  }, [data?.quiz, quiz]);
  // 草稿仅属于当前账号、当前工作区，不改变服务端完成状态。
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>(() => draftStore && quiz && draftStore.get(step.n)?.version === quiz.version
    ? draftStore.get(step.n)!.answers : savedAnswers);
  useEffect(() => {
    setDraftAnswers(draftStore && quiz && draftStore.get(step.n)?.version === quiz.version
      ? draftStore.get(step.n)!.answers : savedAnswers);
  }, [step.n, quiz.version, savedAnswers, draftStore]);

  const answeredAll = quiz.questions.every((question) => Boolean(draftAnswers[question.id]));
  // A 409 invalidates this panel's old verdict, not the student's saved workspace.
  const locallyPassed = !stale && data?.quiz?.version === quiz.version;
  const complete = state.complete && locallyPassed;
  const awaitingSave = locallyPassed && !state.complete && state.syncing;
  const choicesLocked = stale || submitting || awaitingSave;
  const draftChanged = quiz.questions.some((question) => draftAnswers[question.id] !== savedAnswers[question.id]);
  const choose = (questionId: string, optionId: string) => {
    if (choicesLocked) return;
    const next = { ...draftAnswers, [questionId]: optionId };
    draftStore?.set(step.n, { version: quiz.version, answers: next });
    setDraftAnswers(next);
    setFeedback((current) => current.filter((item) => item.question_id !== questionId));
    setError(null);
  };
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const refocusSubmit = useRef(false);
  // A ref, not the state: two clicks before the next render would both see submitting === false and post twice.
  const submittingRef = useRef(false);
  const submit = async () => {
    if (!answeredAll || stale || submitting || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.classroom.submitQuiz({
        step: step.n,
        version: quiz.version,
        answers: draftAnswers,
      });
      if (currentVersion.current !== quiz.version) return;
      setFeedback(result.results);
      if (result.passed) {
        // A student may navigate away and edit a newer draft before this reply.
        // Save the submitted success, but do not delete that newer local draft.
        const submittedDraft = draftStore?.get(step.n);
        if (submittedDraft?.version === quiz.version && submittedDraft.answers === draftAnswers) {
          draftStore?.delete(step.n);
        }
        setDraftAnswers(result.quiz?.answers ?? draftAnswers);
        state.save({
          quiz: result.quiz ?? { version: result.version, answers: draftAnswers },
        });
        // 答题是完成度的唯一来源，不等待普通实验快照的防抖窗口。
        state.syncNow();
      }
    } catch (cause) {
      if (currentVersion.current !== quiz.version) return;
      setError(userFacingRequestError(cause, "答案提交失败，选择已保留，可重试"));
      if (isApiErrorStatus(cause, 409)) {
        const draft = draftStore?.get(step.n);
        if (!draft || draft.version === quiz.version) {
          draftStore?.set(step.n, { version: quiz.version, answers: draft?.answers ?? draftAnswers, stale: true });
        }
        setStale(true);
        setFeedback([]);
        // Refresh shared completion and quiz metadata without replacing local experiment edits.
        // If unavailable, keep the stale warning and the explicit reload action.
        try { await onRefresh?.(); }
        catch { /* The original conflict and the retry action remain visible. */ }
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      refocusSubmit.current = true;
    }
  };
  // The button is disabled while grading and, after a correct answer, while completion saves; that drops
  // keyboard focus to <body>. Give it back once the button is usable again, not one frame after grading.
  const submitDisabled = !answeredAll || stale || submitting || awaitingSave;
  useEffect(() => {
    if (!refocusSubmit.current || submitDisabled) return;
    refocusSubmit.current = false;
    if (document.activeElement == null || document.activeElement === document.body) submitButtonRef.current?.focus();
  }, [submitDisabled]);
  const feedbackByQuestion = new Map(feedback.map((item) => [item.question_id, item]));
  const feedbackId = (questionId: string) => `quiz-feedback-${step.n}-${questionId}`;
  const submitLabel = submitting
    ? "正在判定…"
    : complete
      ? "重新检查答案"
      : awaitingSave
        ? "正在保存…"
        : locallyPassed
          ? "重新提交答案"
          : "提交答案";
  let completionMessage = answeredAll ? "提交后立即显示逐题反馈" : "请先回答全部题目";
  if (locallyPassed) completionMessage = "服务器尚未确认完成，请重新提交答案";
  if (locallyPassed && state.syncError) completionMessage = state.syncConflict
    ? "完成状态尚未保存：你的账号在别处保存了更新的记录，请先点页面顶部的“载入服务器版本”"
    : "完成状态尚未保存，可在页面顶部重试或重新提交答案";
  if (awaitingSave) completionMessage = "答案正确，正在保存完成状态…";
  if (complete) completionMessage = draftChanged
    ? "✓ 理解题已完成；新的选择只用于自查，不影响完成状态（可点“重新检查答案”看反馈）"
    : "✓ 理解题已完成";
  if (stale) completionMessage = "题目已过期，请载入最新题目后重新作答。实验记录和已提交报告不会被删除。";

  return (
    <section className={`quiz-box${complete ? " done" : ""}`} aria-labelledby={`quiz-title-${step.n}`} aria-busy={submitting || awaitingSave}>
      <div className="quiz-head">
        <div>
          <span className="kicker">理解题</span>
          <h3 id={`quiz-title-${step.n}`} tabIndex={-1}>答对本步 {quiz.questions.length} 道理解题</h3>
        </div>
        {/* The draft-persistence rule is reference detail, so it lives in the badge's tooltip. */}
        <span className="quiz-note" title="未提交的选择只在本次登录的页面内暂存，切换步骤会保留；刷新或退出登录后不保留。答对并提交后才保存完成状态。">
          不限重试 · 全部答对即完成
        </span>
      </div>
      {data?.quiz && data.quiz.version !== quiz.version && <p role="status" className="muted">老师已更新本步题目，请重新作答。实验记录和已提交报告不会被删除。</p>}
      <div className="quiz-questions">
        {quiz.questions.map((question, index) => {
          const result = feedbackByQuestion.get(question.id);
          return (
            <fieldset key={question.id} disabled={choicesLocked} className={`quiz-question${result ? result.correct ? " correct" : " incorrect" : ""}`}>
              <legend>{index + 1}. 【{question.kind === "true_false" ? "判断题" : "单选题"}】{question.prompt}</legend>
              <div className="quiz-options">
                {question.options.map((option) => (
                  <label key={option.id}>
                    <input
                      type="radio"
                      name={`quiz-${step.n}-${question.id}`}
                      value={option.id}
                      checked={draftAnswers[question.id] === option.id}
                      // The feedback below is read with the choice, so a wrong answer's hint is not missed.
                      aria-describedby={result ? feedbackId(question.id) : undefined}
                      onChange={() => choose(question.id, option.id)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {result && (
                <p className="quiz-feedback" id={feedbackId(question.id)}>
                  <b>{result.correct ? "回答正确。" : "回答有误。"}</b>{result.explanation}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="quiz-submit-row">
        <button
          ref={submitButtonRef}
          type="button"
          // Once done, re-checking is optional: the next step becomes the one primary action here.
          className={complete ? "secondary" : "primary"}
          disabled={submitDisabled}
          onClick={submit}
        >
          {submitLabel}
        </button>
        <span className={complete ? "quiz-complete" : "muted"}>{completionMessage}</span>
        {complete && next && onNavigate && (
          <button type="button" className="primary quiz-next" onClick={() => onNavigate(next.n)}>
            下一步：{next.title} →
          </button>
        )}
      </div>
      {/* One region, mounted before any result, so screen readers announce each grading (regions created
          together with their text are often skipped). The per-question feedback is read in place. */}
      <span className="sr-only" role="status" aria-live="polite">
        {feedback.length
          // The helper next to the button ("提交后立即显示逐题反馈") is not repeated; a saving or done state is.
          ? `判定结果：${feedback.filter((item) => item.correct).length} / ${quiz.questions.length} 题正确。${locallyPassed || complete ? completionMessage : ""}`
          : ""}
      </span>
      {/* Ready materials are already shown in the task card; only a gap needs a prompt here. */}
      {materialStatus && materialStatus !== "ready" && <div className="quiz-submit-row">
        <span className="muted">报告材料：{MATERIAL_STATUS_LABELS[materialStatus]}。理解题与报告材料分别记录。</span>
        {onRecordMaterials && materialStatus === "missing" && <button type="button" className="secondary" aria-controls={STEP_MATERIAL_ACTION_ID} onClick={onRecordMaterials}>
          去补齐材料
        </button>}
      </div>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {stale && onRefresh && <button type="button" className="secondary" disabled={submitting} onClick={async () => {
        setSubmitting(true);
        try { await onRefresh(); }
        catch (cause) { setError(userFacingRequestError(cause, "载入题目失败，请重试")); }
        finally { setSubmitting(false); }
      }}>载入最新题目</button>}
    </section>
  );
}
