import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { QuizCompletionState, Step, StepStateApi } from "./types";

interface QuizFeedback {
  question_id: string;
  correct: boolean;
  explanation: string;
}

/** 步骤 1–14 的唯一完成条件：答对本步全部固定单选题。 */
export function QuizPanel({
  step,
  state,
}: {
  step: Step;
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
  // 错误选择只保留在当前组件内；服务器只保存全部答对的最终答案。
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>(savedAnswers);
  useEffect(() => {
    setDraftAnswers(savedAnswers);
  }, [step.n, quiz?.version, savedAnswers]);
  if (!quiz) return null;

  const answeredAll = quiz.questions.every((question) => Boolean(draftAnswers[question.id]));
  const locallyPassed = data?.quiz?.version === quiz.version;
  const complete = state.complete;
  const awaitingSave = locallyPassed && !state.complete && state.syncing;
  const choose = (questionId: string, optionId: string) => {
    setDraftAnswers((current) => ({ ...current, [questionId]: optionId }));
    setFeedback([]);
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
        setDraftAnswers(result.quiz?.answers ?? draftAnswers);
        state.save({
          quiz: result.quiz ?? { version: result.version, answers: draftAnswers },
        });
        // 答题是完成度的唯一来源，不等待普通实验快照的防抖窗口。
        state.syncNow();
      }
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
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
  if (complete) completionMessage = "✓ 本步已完成";

  return (
    <section className={`quiz-box${complete ? " done" : ""}`} aria-labelledby={`quiz-title-${step.n}`}>
      <div className="quiz-head">
        <div>
          <span className="kicker">本步完成条件</span>
          <h3 id={`quiz-title-${step.n}`}>答对本步 {quiz.questions.length} 道单选题</h3>
        </div>
        <span className="quiz-note">不限重试 · 全部答对即完成</span>
      </div>
      <div className="quiz-questions">
        {quiz.questions.map((question, index) => {
          const result = feedbackByQuestion.get(question.id);
          return (
            <fieldset key={question.id} className={`quiz-question${result ? result.correct ? " correct" : " incorrect" : ""}`}>
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
      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
