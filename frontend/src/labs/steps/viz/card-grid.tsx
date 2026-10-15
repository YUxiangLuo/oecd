import { Children, useState, type ReactNode } from "react";

/** How many cards a chart shows at once; the rest (the median, each further comparison) open on request. */
export const CARDS_IN_VIEW = 2;

/** The card grid under a chart: the first two cards in view, the others behind one "更多读数" button, so the
 * cards do not repeat the folded readings table at length. */
export function CardGrid({ label, children, className = "comparison-summary" }: { label: string; children: ReactNode; className?: string }) {
  const cards = Children.toArray(children);
  const [all, setAll] = useState(false);
  const hidden = Math.max(0, cards.length - CARDS_IN_VIEW);
  if (!cards.length) return null;
  return (
    <>
      <div className={`${className}${hidden && !all ? " folded" : ""}`} role="group" aria-label={label}>{cards}</div>
      {hidden > 0 && (
        <button type="button" className="secondary comparison-summary-toggle" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "收起读数" : `更多读数（${hidden}）`}
        </button>
      )}
    </>
  );
}
