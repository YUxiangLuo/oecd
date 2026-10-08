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
 * and keep each label/control pair together when a flex row wraps.
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
    <span className="labeled-control">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </span>
  );
}

type ScrollableRegionProps = Omit<HTMLAttributes<HTMLDivElement>, "aria-label" | "aria-labelledby"> & {
  label?: string;
  labelledBy?: string;
  /** Composite widgets can provide their own single roving focus stop. */
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
 * Implements the modal-dialog keyboard contract: initial focus, focus trapping,
 * close handling, and focus restoration.
 */
export function useDialogFocus({
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onClose,
  keepFocusInside = false,
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<DialogFocusTarget | null>;
  returnFocusRef?: RefObject<DialogFocusTarget | null>;
  onClose: () => void;
  /**
   * For a dialog that is the same subtree expanded in place (fullscreen panels): when focus is already
   * inside it, leave it there on open and return to it on close, so a keyboard user keeps their place.
   */
  keepFocusInside?: boolean;
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

    const keptInside = keepFocusInside && previouslyFocused != null && previouslyFocused !== container && container.contains(previouslyFocused)
      ? previouslyFocused
      : null;
    const initial = keptInside
      ?? initialFocusRef?.current
      ?? container.querySelector<HTMLElement>("[autofocus]")
      ?? focusableWithin(container)[0]
      ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // A nested dialog opened on top marks this one inert; only the topmost dialog reacts.
      if (container.closest("[inert]")) return;
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
      // In-place dialogs return to where the reader is now (e.g. the cell moved to with the arrow keys).
      const current = document.activeElement;
      const stayInside = keepFocusInside && isDialogFocusTarget(current) && current !== container && container.contains(current)
        ? current
        : keptInside;
      queueMicrotask(() => {
        // Portalled dialogs can replace their trigger DOM node while closing. Read
        // an explicit return ref after that commit so SVG controls can restore focus
        // to the newly mounted counterpart rather than a disconnected old node.
        const explicitTarget = stayInside?.isConnected ? stayInside : returnFocusRef?.current;
        const target = explicitTarget?.isConnected ? explicitTarget : fallbackTarget;
        // React Strict Mode immediately runs setup again after its development-only
        // cleanup. Do not let that stale cleanup pull focus back behind the dialog.
        if (focusCycleRef.current === focusCycle && target?.isConnected) {
          target.focus();
          // An in-place dialog can close with focus already on the target (e.g. the 年份 select of a panel that
          // was fullscreen): focus() is then a no-op and does not scroll, and the page scroller keeps its old
          // position, so the focused control can sit off-screen. Bring it into view explicitly.
          target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }
      });
    };
  }, [containerRef, initialFocusRef, keepFocusInside, returnFocusRef]);
}

/**
 * After a retry button starts a reload, the button (and the error box around it) usually unmounts when the
 * request succeeds, which drops keyboard focus onto <body>. Keep it nearby: once focus is lost, move it to the
 * closest ancestor of the button that is still on the page (made programmatically focusable). Stops when the
 * user moves focus elsewhere or after a few seconds.
 */
export function keepFocusNear(button: HTMLElement | null, timeoutMs = 5000): void {
  if (!button) return;
  const ancestors: HTMLElement[] = [];
  for (let node = button.parentElement?.parentElement; node && node !== document.body && ancestors.length < 6; node = node.parentElement) {
    ancestors.push(node);
  }
  const start = performance.now();
  const tick = () => {
    if (performance.now() - start > timeoutMs) return;
    const active = document.activeElement;
    if (active == null || active === document.body) {
      const target = ancestors.find((node) => node.isConnected);
      if (target) {
        if (!target.hasAttribute("tabindex")) {
          target.setAttribute("tabindex", "-1");
          target.dataset.focusAnchor = "";
        }
        target.focus({ preventScroll: true });
      }
      return;
    }
    if (active !== button && !ancestors.some((node) => node.contains(active))) return;
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}
