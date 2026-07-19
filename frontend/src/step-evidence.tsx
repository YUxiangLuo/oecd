import { useState } from "react";
import { api } from "./api";
import type { CerEvidence, CerStepEvidence, StepEvidenceApi } from "./types";

/** 学习证据的共用界面:本步还差什么、以及需要写判断时的输入框。
 *
 * “还差什么”一律用服务端返回的 missing 文案,不在前端另写一套判定——
 * 完成的定义只能有一个来源。
 */

export function EvidencePanel({ evidence, title = "本步要留下的证据" }: {
  // 只声明真正读到的两个字段:声明成 StepEvidenceApi<never> 会逼每个实验台
  // 写 `as StepEvidenceApi<never>`,而那种转型会把类型检查一并绕过。
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
        <p className="muted">你已经留下了这一步要求的证据；第 16 步会按原样汇总你的主张、数据、理由与边界。</p>
      ) : (
        <ul>{evidence.missing.map((item) => <li key={item}>{item}</li>)}</ul>
      )}
    </section>
  );
}

const CER_FIELDS: {
  key: keyof CerEvidence;
  label: string;
  prompt: string;
  placeholder: string;
}[] = [
  {
    key: "claim",
    label: "主张 Claim",
    prompt: "先用一句话回答：你从这一步发现了什么？",
    placeholder: "例如：越南出口的外国增加值依赖高于中国。",
  },
  {
    key: "evidence",
    label: "证据 Evidence",
    prompt: "写出具体年份、国家/行业、指标名称与数值。",
    placeholder: "例如：2020 年，VNM A01_02 的 FVA 份额为 …%，CHN 为 …%。",
  },
  {
    key: "reasoning",
    label: "理由 Reasoning",
    prompt: "解释这些数值为什么支持你的主张，而不只是复述大小。",
    placeholder: "因为 FVA 份额衡量出口中外国投入创造的价值占比，所以……",
  },
  {
    key: "boundary",
    label: "边界 Boundary",
    prompt: "指出一个口径、数据质量或因果解释限制。",
    placeholder: "例如：这里只是单年描述性比较，不能证明政策造成了差异。",
  },
];

/** Steps 1 and 3–11 share one compact, report-ready CER editor. */
export function CerBox({ value, onChange, title = "把操作变成可核查的结论" }: {
  value?: Partial<CerEvidence>;
  onChange: (value: CerEvidence) => void;
  title?: string;
}) {
  const current: CerEvidence = {
    claim: value?.claim ?? "",
    evidence: value?.evidence ?? "",
    reasoning: value?.reasoning ?? "",
    boundary: value?.boundary ?? "",
  };
  const update = (key: keyof CerEvidence, next: string) => onChange({ ...current, [key]: next });
  return (
    <section className="cer-box">
      <div className="cer-head">
        <div>
          <span className="kicker">CER 学习证据</span>
          <h3>{title}</h3>
        </div>
        <span className="cer-note">四项都会进入报告</span>
      </div>
      <div className="cer-grid">
        {CER_FIELDS.map((field) => {
          const text = current[field.key];
          return (
            <label key={field.key} className="cer-field">
              <b>{field.label}</b>
              <span>{field.prompt}</span>
              <textarea
                rows={field.key === "evidence" || field.key === "reasoning" ? 3 : 2}
                value={text}
                placeholder={field.placeholder}
                onChange={(event) => update(field.key, event.target.value)}
              />
              <small className={text.trim().length >= 12 ? "ok" : ""}>
                {text.trim().length >= 12 ? `已记录 ${text.trim().length} 字` : "请至少写 12 字"}
              </small>
            </label>
          );
        })}
      </div>
    </section>
  );
}

type DescriptiveEvidenceKind = "slice" | "indicator" | "visualization" | "shock";

/**
 * Saves the draft locally, then explicitly asks the server to bind it to the
 * current account, step and manifest. Editing a signed draft invalidates the
 * old id, so stale evidence can never silently satisfy a newer answer.
 */
export function VerifiedCerBox<T extends CerStepEvidence & Record<string, unknown>>({
  step,
  kind,
  evidence,
  context,
  ready = true,
}: {
  step: number;
  kind: DescriptiveEvidenceKind;
  evidence: StepEvidenceApi<T>;
  context: Record<string, unknown>;
  ready?: boolean;
}) {
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cer = evidence.data?.cer;
  const completeDraft = [cer?.claim, cer?.evidence, cer?.reasoning, cer?.boundary]
    .every((text) => typeof text === "string" && text.trim().length >= 12);
  const signed = typeof evidence.data?.evidence_id === "string" && Boolean(evidence.data.evidence_id);

  const change = (next: CerEvidence) => {
    // Invalidate the prior server binding whenever the student changes the answer.
    evidence.save({ cer: next, evidence_id: "" } as Partial<T>);
    setError(null);
  };
  const issue = async () => {
    if (!ready || !completeDraft || issuing) return;
    setIssuing(true);
    setError(null);
    try {
      // The signature covers exactly what will be persisted. Include existing
      // operation fields, but never include the prior signature itself.
      const payload: Record<string, unknown> = { ...(evidence.data ?? {}), ...context, cer };
      delete payload.evidence_id;
      const result = await api.classroom.issueEvidence({ step, kind, payload });
      // 持久化服务端归一后的精确 payload；签名验证必须与服务端实际签收内容逐字段一致。
      evidence.save({ ...(result.evidence ?? payload), evidence_id: result.evidence_id } as Partial<T>);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally {
      setIssuing(false);
    }
  };

  return (
    <>
      <CerBox value={cer} onChange={change} />
      <div className="cer-submit-row">
        <button type="button" className="primary" disabled={!ready || !completeDraft || issuing} onClick={issue}>
          {issuing ? "正在核验…" : signed ? "重新提交可核查证据" : "提交可核查证据"}
        </button>
        <span className={signed ? "cer-signed" : "muted"}>
          {signed ? "✓ 已由服务器绑定到本账号、步骤与当前数据版本" : !ready ? "请先完成本步指定操作" : !completeDraft ? "请先完成上方四项，每项至少 12 字" : "提交后才计入完成度"}
        </span>
      </div>
      {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
    </>
  );
}

/** 需要学生写下判断的步骤(质检取舍、四步回归的识别判断)共用。 */
export function JudgmentBox({ prompt, hint, value, minChars, onChange }: {
  prompt: string;
  hint?: string;
  value: string;
  minChars: number;
  onChange: (next: string) => void;
}) {
  const length = value.trim().length;
  const enough = length >= minChars;
  return (
    <div className="judgment-box">
      <label htmlFor="judgment-input"><b>{prompt}</b></label>
      {hint && <p className="muted judgment-hint">{hint}</p>}
      <textarea
        id="judgment-input"
        rows={3}
        value={value}
        placeholder="用一两句话写下你的判断和理由"
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={`judgment-count${enough ? " ok" : ""}`}>
        {enough ? `已记录(${length} 字)` : `还需 ${minChars - length} 字`}
      </div>
    </div>
  );
}
