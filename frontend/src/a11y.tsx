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
  /** Composite widgets can provide their own single roving Tab stop. */
  focusable?: boolean;
};

/** A named overflow region, keyboard-focusable by default. */
export function ScrollableRegion({
  label,
  labelledBy,
  focusable = true,
  className = "",
  children,
  ...props
}: ScrollableRegionProps) {
  return (
    <div
      {...props}
      className={`${className} scrollable-region`.trim()}
      role="region"
      tabIndex={focusable ? 0 : -1}
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

type DialogFocusTarget = HTMLElement | SVGElement;

function isDialogFocusTarget(element: Element | null): element is DialogFocusTarget {
  return element instanceof HTMLElement || element instanceof SVGElement;
}

function focusableWithin(container: HTMLElement): DialogFocusTarget[] {
  return [...container.querySelectorAll<DialogFocusTarget>(FOCUSABLE)].filter(
    (element) => (!(element instanceof HTMLElement) || !element.hidden)
      && element.getAttribute("aria-hidden") !== "true",
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
  initialFocusRef?: RefObject<DialogFocusTarget | null>;
  returnFocusRef?: RefObject<DialogFocusTarget | null>;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  const focusCycleRef = useRef(0);
  const restoreTargetRef = useRef<DialogFocusTarget | null>(null);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const focusCycle = ++focusCycleRef.current;
    const previouslyFocused = isDialogFocusTarget(document.activeElement) ? document.activeElement : null;
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
      const fallbackTarget = restoreTargetRef.current ?? previouslyFocused;
      queueMicrotask(() => {
        // Portalled dialogs can replace their trigger DOM node while closing. Read
        // an explicit return ref after that commit so SVG controls can restore focus
        // to the newly mounted counterpart rather than a disconnected old node.
        const explicitTarget = returnFocusRef?.current;
        const target = explicitTarget?.isConnected ? explicitTarget : fallbackTarget;
        // React Strict Mode immediately runs setup again after its development-only
        // cleanup. Do not let that stale cleanup pull focus back behind the dialog.
        if (focusCycleRef.current === focusCycle && target?.isConnected) target.focus();
      });
    };
  }, [containerRef, initialFocusRef, returnFocusRef]);
}
