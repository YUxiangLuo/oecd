import { forwardRef, type ReactNode } from "react";

export interface ScopeItem {
  /** Small caption above the value, e.g. 比较对象 / 范围 / 年份 / 指标. */
  label: string;
  value: ReactNode;
  /** Focus the control that changes this part of the scope (chips without it are plain text). */
  onJump?: () => void;
}

/**
 * Sticky scope summary (design doc 4.5): what the chart below shows, as chips the student can click to
 * jump to the matching control. The group keeps the aria-label "当前比较口径" that tests and the manual
 * capture script rely on; the chips read as "label value" one after another.
 */
export const ScopeCard = forwardRef<HTMLDivElement, { items: ScopeItem[]; note?: ReactNode }>(function ScopeCard(
  { items, note },
  ref,
) {
  return (
    <div ref={ref} tabIndex={-1} className="scope-card" role="group" aria-label="当前比较口径">
      {items.map((item, index) => {
        const body = (
          <>
            <span>{item.label}</span>
            <b>{item.value}</b>
          </>
        );
        return (
          <span key={`${item.label}-${index}`} className="scope-item">
            {item.onJump ? (
              <button type="button" className="scope-chip" onClick={item.onJump} title={`修改${item.label}`}>
                {body}
                <span className="sr-only">（修改）</span>
              </button>
            ) : (
              <span className="scope-chip scope-chip-static">{body}</span>
            )}
            {/* After the chip, so a wrapped line never starts with the separator. */}
            {index < items.length - 1 && <i aria-hidden="true" className="scope-sep">·</i>}
          </span>
        );
      })}
      {note && <small className="scope-note">{note}</small>}
    </div>
  );
});
