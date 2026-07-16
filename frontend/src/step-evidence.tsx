import type { StepEvidenceApi } from "./types";

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
        <p className="muted">你已经留下了这一步要求的证据;它会进入第 16 步的实验报告。</p>
      ) : (
        <ul>{evidence.missing.map((item) => <li key={item}>{item}</li>)}</ul>
      )}
    </section>
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
