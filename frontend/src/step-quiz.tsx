import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MATERIAL_STATUS_LABELS, STEP_MATERIAL_ACTION_ID, type StepMaterialStatus } from "./step-task-card";
import type { QuizCompletionState, Step, StepStateApi } from "./types";
import { userFacingRequestError } from "./user-facing-error";

export type QuizDraftStore = Map<number, { version: string; answers: Record<string, string> }>;

interface QuizFeedback {
  question_id: string;
  correct: boolean;
  explanation: string;
}

/** 步骤 1–14 的唯一完成条件：答对本步全部固定单选题。 */
export function QuizPanel({
  step,
  state,
  draftStore,
  materialStatus,
  onRecordMaterials,
}: {
  step: Step;
  draftStore?: QuizDraftStore;
  materialStatus?: StepMaterialStatus;
  onRecordMaterials?: () => void;
  state: StepStateApi<Record<string, unknown>>;
}) {
  const quiz = step.quiz;
  const data = state.data as (QuizCompletionState & Record<string, unknown>) | undefined;
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<QuizFeedback[]>([]);
  const [error, setError] = useState<string | null>(null);
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
  }, [step.n, quiz?.version, savedAnswers, draftStore]);
  if (!quiz) return null;

  const answeredAll = quiz.questions.every((question) => Boolean(draftAnswers[question.id]));
  const locallyPassed = data?.quiz?.version === quiz.version;
  const complete = state.complete;
  const awaitingSave = locallyPassed && !state.complete && state.syncing;
  const choicesLocked = submitting || awaitingSave;
  const draftChanged = quiz.questions.some((question) => draftAnswers[question.id] !== savedAnswers[question.id]);
  const choose = (questionId: string, optionId: string) => {
    if (choicesLocked) return;
    const next = { ...draftAnswers, [questionId]: optionId };
    draftStore?.set(step.n, { version: quiz.version, answers: next });
    setDraftAnswers(next);
    setFeedback((current) => current.filter((item) => item.question_id !== questionId));
    setError(null);
  };
  const submit = async () => {
    if (!answeredAll || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.classroom.submitQuiz({
        step: step.n,
        version: quiz.version,
        answers: draftAnswers,
      });
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
      setError(userFacingRequestError(cause, "答案提交失败，选择已保留，可重试"));
    } finally {
      setSubmitting(false);
    }
  };
  const feedbackByQuestion = new Map(feedback.map((item) => [item.question_id, item]));
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
  if (locallyPassed && state.syncError) completionMessage = "完成状态尚未保存，可在页面顶部重试或重新提交答案";
  if (awaitingSave) completionMessage = "答案正确，正在保存完成状态…";
  if (complete) completionMessage = draftChanged
    ? "✓ 已保存答案已通过；当前修改尚未提交"
    : "✓ 理解题已完成";

  return (
    <section className={`quiz-box${complete ? " done" : ""}`} aria-labelledby={`quiz-title-${step.n}`} aria-busy={choicesLocked}>
      <div className="quiz-head">
        <div>
          <span className="kicker">理解题</span>
          <h3 id={`quiz-title-${step.n}`}>答对本步 {quiz.questions.length} 道单选题</h3>
        </div>
        {/* The draft-persistence rule is reference detail, so it lives in the badge's tooltip. */}
        <span className="quiz-note" title="未提交的选择仅在本次登录的页面内暂存，切换步骤会保留；刷新或退出后不保留。答对并提交后才保存完成状态。">
          不限重试 · 全部答对即完成
        </span>
      </div>
      <div className="quiz-questions">
        {quiz.questions.map((question, index) => {
          const result = feedbackByQuestion.get(question.id);
          return (
            <fieldset key={question.id} disabled={choicesLocked} className={`quiz-question${result ? result.correct ? " correct" : " incorrect" : ""}`}>
              <legend>{index + 1}. {question.prompt}</legend>
              <div className="quiz-options">
                {question.options.map((option) => (
                  <label key={option.id}>
                    <input
                      type="radio"
                      name={`quiz-${step.n}-${question.id}`}
                      value={option.id}
                      checked={draftAnswers[question.id] === option.id}
                      onChange={() => choose(question.id, option.id)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {result && (
                <p className="quiz-feedback" role="status">
                  <b>{result.correct ? "回答正确。" : "这项还不对。"}</b>{result.explanation}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="quiz-submit-row">
        <button
          type="button"
          className="primary"
          disabled={!answeredAll || submitting || awaitingSave}
          onClick={submit}
        >
          {submitLabel}
        </button>
        <span className={complete ? "quiz-complete" : "muted"}>{completionMessage}</span>
      </div>
      {/* Ready materials are already shown in the task card; only a gap needs a prompt here. */}
      {materialStatus && materialStatus !== "ready" && <div className="quiz-submit-row">
        <span className="muted">报告材料：{MATERIAL_STATUS_LABELS[materialStatus]}。理解题与报告材料分别记录。</span>
        {onRecordMaterials && materialStatus === "missing" && <button type="button" className="secondary" aria-controls={STEP_MATERIAL_ACTION_ID} onClick={onRecordMaterials}>
          去补齐材料
        </button>}
      </div>}
      {error && <div className="error-box" role="alert">{error}</div>}
    </section>
  );
}
