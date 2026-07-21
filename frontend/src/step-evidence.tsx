import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { QuizStepEvidence, Step, StepEvidenceApi } from "./types";

/** 服务端完成度的统一展示；前端不复制完成判定。 */
export function EvidencePanel({ evidence, title = "本步要完成的证据" }: {
  evidence: Pick<StepEvidenceApi, "missing" | "complete">;
  title?: string;
}) {
  return (
    <section className={`evidence-panel${evidence.complete ? " done" : ""}`} aria-live="polite">
      <div className="evidence-head">
        <span className="evidence-badge">{evidence.complete ? "✓" : "!"}</span>
        <b>{evidence.complete ? "本步已完成" : title}</b>
      </div>
      {evidence.complete ? (
        <p className="muted">真实操作和理解检查均已由服务器确认；第 16 步会把它们汇总进报告。</p>
      ) : (
        <ul>{evidence.missing.map((item) => <li key={item}>{item}</li>)}</ul>
      )}
    </section>
  );
}

type ActionEvidenceKind = "slice" | "indicator" | "visualization" | "shock";

/**
 * 把已经完成的真实操作交给服务器复核。选择题拥有独立凭证，提交操作时只发送
 * 明确的 context，避免答题变化迫使学生重新选择数据或重新跑实验。
 */
export function VerifiedActionBox<T extends QuizStepEvidence & Record<string, unknown>>({
  step,
  kind,
  evidence,
  context,
  ready = true,
}: {
  step: number;
  kind: ActionEvidenceKind;
  evidence: StepEvidenceApi<T>;
  context: Record<string, unknown>;
  ready?: boolean;
}) {
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signed = typeof evidence.data?.evidence_id === "string" && Boolean(evidence.data.evidence_id);

  const issue = async () => {
    if (!ready || issuing) return;
    setIssuing(true);
    setError(null);
    try {
      const result = await api.classroom.issueEvidence({ step, kind, payload: context });
      evidence.save({ ...(result.evidence ?? context), evidence_id: result.evidence_id } as Partial<T>);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally {
      setIssuing(false);
    }
  };

  return (
    <section className="action-evidence-box">
      <div className="evidence-submit-row">
        <button type="button" className="primary" disabled={!ready || issuing} onClick={issue}>
          {issuing ? "正在核验…" : signed ? "重新提交操作证据" : "提交操作证据"}
        </button>
        <span className={signed ? "evidence-signed" : "muted"}>
          {signed
            ? "✓ 真实操作已绑定到本账号、步骤与当前数据版本"
            : ready
              ? "提交后由服务器复核数据与操作"
              : "请先完成本步指定操作"}
        </span>
      </div>
      {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
    </section>
  );
}

interface QuizFeedback {
  question_id: string;
  correct: boolean;
  explanation: string;
}

/** 步骤 1–15 共用的固定单选题。 */
export function QuizPanel({
  step,
  evidence,
}: {
  step: Step;
  evidence: StepEvidenceApi<Record<string, unknown>>;
}) {
  const quiz = step.quiz;
  const data = evidence.data as (QuizStepEvidence & Record<string, unknown>) | undefined;
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<QuizFeedback[]>([]);
  const [error, setError] = useState<string | null>(null);
  const savedAnswers = useMemo(() => {
    if (!quiz || !data?.quiz_id || data.quiz?.version !== quiz.version) return {};
    return data.quiz.answers ?? {};
  }, [data?.quiz, data?.quiz_id, quiz]);
  // 未通过的选择只留在当前组件内：服务器不保存错误尝试，刷新后也不会恢复。
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>(savedAnswers);
  useEffect(() => {
    setDraftAnswers(savedAnswers);
  }, [step.n, quiz?.version, savedAnswers]);
  if (!quiz) return null;

  const answers = draftAnswers;
  const answeredAll = quiz.questions.every((question) => Boolean(answers[question.id]));
  const signed = Boolean(data?.quiz_id) && data?.quiz?.version === quiz.version;
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
      const result = await api.classroom.submitQuiz({ step: step.n, version: quiz.version, answers });
      setFeedback(result.results);
      if (result.passed && result.quiz_id) {
        setDraftAnswers(result.quiz?.answers ?? answers);
        evidence.save({
          quiz: result.quiz ?? { version: result.version, answers },
          quiz_id: result.quiz_id,
        });
      }
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally {
      setSubmitting(false);
    }
  };
  const feedbackByQuestion = new Map(feedback.map((item) => [item.question_id, item]));

  return (
    <section className={`quiz-box${signed ? " done" : ""}`} aria-labelledby={`quiz-title-${step.n}`}>
      <div className="quiz-head">
        <div>
          <span className="kicker">理解检查</span>
          <h3 id={`quiz-title-${step.n}`}>答对本步 {quiz.questions.length} 道单选题</h3>
        </div>
        <span className="quiz-note">不限重试 · 全部答对才完成</span>
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
                      checked={answers[question.id] === option.id}
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
      <div className="evidence-submit-row quiz-submit-row">
        <button type="button" className="primary" disabled={!answeredAll || submitting} onClick={submit}>
          {submitting ? "正在判定…" : signed ? "重新检查答案" : "提交理解检查"}
        </button>
        <span className={signed ? "evidence-signed" : "muted"}>
          {signed ? "✓ 本步理解检查已通过并由服务器签发凭证" : answeredAll ? "提交后立即显示逐题反馈" : "请先回答全部题目"}
        </span>
      </div>
      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
