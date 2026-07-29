import {
  useId,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * Keep visible form labels and their controls programmatically associated
 * without changing the existing label/control sibling layout.
 */
export function LabeledControl({
  label,
  children,
}: {
  label: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </>
  );
}

type ScrollableRegionProps = Omit<HTMLAttributes<HTMLDivElement>, "aria-label" | "aria-labelledby"> & {
  label?: string;
  labelledBy?: string;
};

/** A keyboard-focusable, named overflow region. */
export function ScrollableRegion({
  label,
  labelledBy,
  className = "",
  children,
  ...props
}: ScrollableRegionProps) {
  return (
    <div
      {...props}
      className={`${className} scrollable-region`.trim()}
      role="region"
      tabIndex={0}
      aria-label={label}
      aria-labelledby={labelledBy}
    >
      {children}
    </div>
  );
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Implements the modal-dialog keyboard contract: initial focus, Tab trapping,
 * Escape to close, and focus restoration.
 */
export function useDialogFocus({
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onClose,
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  const focusCycleRef = useRef(0);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const focusCycle = ++focusCycleRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (previouslyFocused && !container.contains(previouslyFocused)) {
      restoreTargetRef.current = previouslyFocused;
    }

    const initial = initialFocusRef?.current
      ?? container.querySelector<HTMLElement>("[autofocus]")
      ?? focusableWithin(container)[0]
      ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableWithin(container);
      if (!focusable.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const target = returnFocusRef?.current ?? restoreTargetRef.current ?? previouslyFocused;
      queueMicrotask(() => {
        // React Strict Mode immediately runs setup again after its development-only
        // cleanup. Do not let that stale cleanup pull focus back behind the dialog.
        if (focusCycleRef.current === focusCycle && target?.isConnected) target.focus();
      });
    };
  }, [containerRef, initialFocusRef, returnFocusRef]);
}
