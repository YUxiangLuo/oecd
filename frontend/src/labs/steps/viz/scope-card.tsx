import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface ScopeItem {
  /** Small caption above the value, e.g. 所选国家 / 范围 / 年份 / 指标. */
  label: string;
  value: ReactNode;
  /** Focus the control that changes this part of the scope (chips without it are plain text). */
  onJump?: () => void;
}

/** Which items end a wrapped line: the next item starts at or below this one's bottom edge. (Items on one line are
 * centred, so a shorter neighbour on the same line has a larger top but still starts above this one's bottom.) */
export function lineEnds(boxes: readonly { top: number; bottom: number }[]): boolean[] {
  // An item with no height has not been laid out (a hidden card): nothing to hide.
  return boxes.map((box, index) => index < boxes.length - 1 && box.bottom > box.top && boxes[index + 1].top >= box.bottom - 1);
}

/**
 * Sticky scope summary (design doc 4.5): what the chart below shows, as chips the student can click to
 * jump to the matching control. The group keeps the aria-label "当前图表范围" that tests and the manual
 * capture script rely on; the chips read as "label value" one after another.
 */
export const ScopeCard = forwardRef<HTMLDivElement, { items: ScopeItem[]; note?: ReactNode }>(function ScopeCard(
  { items, note },
  ref,
) {
  const card = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [ends, setEnds] = useState<boolean[]>([]);
  // A separator left at the end of a wrapped line (1000 px: "年份 2016 ·" then 指标 below) is hidden. Hidden, not
  // removed, so the line keeps its width and the wrap does not move back and forth.
  const measure = useRef(() => {});
  measure.current = () => {
    const next = lineEnds(itemRefs.current.slice(0, items.length).map((item) => ({
      top: item?.offsetTop ?? 0,
      bottom: (item?.offsetTop ?? 0) + (item?.offsetHeight ?? 0),
    })));
    setEnds((previous) => (previous.length === next.length && previous.every((value, index) => value === next[index]) ? previous : next));
  };
  // After every render (the chips' text changes with the chart) and whenever the card is resized.
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    if (!card.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(card.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={(node) => {
        card.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      tabIndex={-1} className="scope-card" role="group" aria-label="当前图表范围"
    >
      {items.map((item, index) => {
        const body = (
          <>
            <span>{item.label}</span>
            <b>{item.value}</b>
          </>
        );
        return (
          <span key={`${item.label}-${index}`} className="scope-item" ref={(node) => { itemRefs.current[index] = node; }}>
            {item.onJump ? (
              <button type="button" className="scope-chip" onClick={item.onJump} title={`修改${item.label}`}>
                {body}
                <span className="sr-only">（修改）</span>
              </button>
            ) : (
              <span className="scope-chip scope-chip-static">{body}</span>
            )}
            {/* After the chip, so a wrapped line never starts with the separator. */}
            {index < items.length - 1 && (
              <i aria-hidden="true" className="scope-sep" style={ends[index] ? { visibility: "hidden" } : undefined}>·</i>
            )}
          </span>
        );
      })}
      {note && <small className="scope-note">{note}</small>}
    </div>
  );
});
