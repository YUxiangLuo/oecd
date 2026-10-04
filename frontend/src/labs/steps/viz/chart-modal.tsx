/**
 * Supplementary charts for steps 6–9 open in a modal instead of replacing the main chart, so the
 * student never loses the chart that feeds the report and closing always returns to the same place.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../../../a11y";
import { isolateFullscreenSiblings, lockFullscreenScroll } from "../../../fullscreen-panel";

function ChartModalDialog({ title, onClose, returnFocus, children }: {
  title: string;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus({ containerRef: dialogRef, initialFocusRef: closeRef, returnFocusRef: returnFocus, onClose });
  useEffect(() => {
    const restoreScroll = lockFullscreenScroll(document.body, document.querySelector<HTMLElement>(".content"));
    const restoreIsolation = dialogRef.current?.parentElement
      ? isolateFullscreenSiblings(dialogRef.current.parentElement)
      : () => {};
    return () => {
      restoreIsolation();
      restoreScroll();
    };
  }, []);
  return createPortal(
    <div className="chart-modal-scrim" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="chart-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="chart-modal-head">
          <b id={titleId}>{title}</b>
          <button ref={closeRef} type="button" className="chart-modal-close" onClick={onClose}>
            关闭 <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="chart-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A labelled button that opens one supplementary chart in a modal. Content mounts only while open. */
export function ChartModalButton({ label, title, children }: {
  label: string;
  title: string;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" className="chart-modal-trigger secondary" onClick={() => setOpen(true)}>
        {label} <span aria-hidden="true">↗</span>
      </button>
      {open && (
        <ChartModalDialog title={title} onClose={() => setOpen(false)} returnFocus={triggerRef}>
          {children()}
        </ChartModalDialog>
      )}
    </>
  );
}

/** Row of supplementary-chart buttons under a main chart. */
export function SupplementaryCharts({ children }: { children: ReactNode }) {
  return (
    <div className="supplementary-charts" role="group" aria-label="补充图表">
      <span>补充图表（弹窗查看，不替换主图）：</span>
      {children}
    </div>
  );
}
