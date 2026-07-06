/**
 * 可复用的「页内多阶段向导」容器。内容无关:只认 Stage[](key/title/node),
 * 负责进度点 + 阶段标题 + 上一步/下一步。后续步骤只需提供自己的 stages 数组。
 *
 * 关键实现:所有阶段一次性挂载,用 hidden 只显当前 —— 这样各阶段的本地状态
 * (如原始表浏览器的分页/筛选、示意矩阵的选中格)在来回切阶段时不会丢失/重拉。
 */
import { useState, type ReactNode } from "react";

export interface Stage {
  key: string;
  title: string;
  node: ReactNode;
  canAdvance?: boolean; // 默认 true;false 时禁用「下一步」
  navHint?: string;     // 被 gate 时在「下一步」旁的提示
}

export function StepStages({ stages, initial = 0, onComplete }: {
  stages: Stage[];
  initial?: number;
  onComplete?: () => void;
}) {
  const [current, setCurrent] = useState(initial);
  const n = stages.length;
  const stage = stages[current];
  const atLast = current >= n - 1;
  const gated = stage?.canAdvance === false;
  const go = (i: number) => setCurrent(Math.max(0, Math.min(n - 1, i)));
  const next = () => {
    if (atLast) { onComplete?.(); return; }
    if (!gated) go(current + 1);
  };

  return (
    <div className="wizard">
      <div className="wizard-top">
        <div className="wizard-dots">
          {stages.map((s, i) => (
            <button
              key={s.key}
              className={`wizard-dot${i === current ? " on" : i < current ? " past" : ""}`}
              title={`${i + 1}. ${s.title}`}
              aria-label={s.title}
              onClick={() => go(i)}
            />
          ))}
        </div>
        <span className="wizard-counter">阶段 {current + 1} / {n}</span>
      </div>

      <div className="wizard-head">{stage?.title}</div>

      {stages.map((s, i) => (
        <div key={s.key} className="stage-pane" hidden={i !== current}>
          {s.node}
        </div>
      ))}

      <div className="wizard-foot">
        <button disabled={current === 0} onClick={() => go(current - 1)}>← 上一步</button>
        <span className="wizard-foot-mid">
          {gated && stage?.navHint && <span className="muted">{stage.navHint}</span>}
        </span>
        <button
          className="primary"
          disabled={gated || (atLast && !onComplete)}
          onClick={next}
        >
          {atLast ? (onComplete ? "完成 ✓" : "本步已完成 ✓") : "下一步 →"}
        </button>
      </div>
    </div>
  );
}
