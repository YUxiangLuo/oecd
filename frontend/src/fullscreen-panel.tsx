import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useDialogFocus } from "./a11y";
import { FullscreenSyncProblem } from "./sync-problem";

type FullscreenVariant = "table" | "workbench" | "shock" | "heat";

type ScrollLockElement = {
  style: {
    overflow: string;
    overflowY: string;
  };
};

/** Lock both possible page scrollers and restore their exact prior inline styles. */
export function lockFullscreenScroll(
  body: ScrollLockElement,
  courseScroller: ScrollLockElement | null,
) {
  const previousBodyOverflow = body.style.overflow;
  const previousCourseOverflowY = courseScroller?.style.overflowY;
  body.style.overflow = "hidden";
  if (courseScroller) courseScroller.style.overflowY = "hidden";

  return () => {
    body.style.overflow = previousBodyOverflow;
    if (courseScroller && previousCourseOverflowY !== undefined) {
      courseScroller.style.overflowY = previousCourseOverflowY;
    }
  };
}

/**
 * Make every branch outside a nested modal inert without disabling the modal's
 * own ancestors.  This is the DOM equivalent of portaling the dialog while
 * preserving the component's live state and request cache.
 */
export function isolateFullscreenSiblings(container: HTMLElement) {
  const changed: Array<{ element: HTMLElement; inert: boolean }> = [];
  let branch: HTMLElement | null = container;
  while (branch?.parentElement) {
    const parent: HTMLElement = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      changed.push({ element: sibling, inert: sibling.inert });
      sibling.inert = true;
    }
    branch = parent;
    if (parent === document.body) break;
  }
  return () => {
    changed.reverse().forEach(({ element, inert }) => { element.inert = inert; });
  };
}

function FullscreenDialogBehavior({
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onClose,
}: {
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  useDialogFocus({ containerRef, initialFocusRef, returnFocusRef, onClose, keepFocusInside: true });

  useEffect(() => {
    const courseScroller = containerRef.current?.closest<HTMLElement>(".content") ?? null;
    const restoreScroll = lockFullscreenScroll(document.body, courseScroller);
    const restoreIsolation = containerRef.current
      ? isolateFullscreenSiblings(containerRef.current)
      : () => {};
    return () => {
      restoreIsolation();
      restoreScroll();
    };
  }, [containerRef]);

  return null;
}

const FullscreenTriggerContext = createContext<ReactNode>(null);

/**
 * Where a collapsed panel's entry button sits when the panel is given `triggerInContent`: render it at the end of
 * the first control row, so Tab reaches it in the order the row reads (年份 … 全屏查看) rather than first.
 * Renders nothing while the panel is expanded (the bar then carries 退出全屏) or when the entry is disabled.
 */
export function FullscreenTriggerSlot() {
  const trigger = useContext(FullscreenTriggerContext);
  return trigger ? <span className="fullscreen-trigger-slot" style={{ marginLeft: "auto" }}>{trigger}</span> : null;
}

/**
 * 把同一块交互内容切换到覆盖视口的模态工作区。
 *
 * 面板始终是同一棵 DOM / React 子树，只通过 fixed 定位切换形态，因此进入大图不会
 * 重挂载内部组件、重复数据请求或丢失搜索等临时状态。`enabled` 只控制内联入口；已经
 * 进入大图后，即使内容切换到不需要入口的视角，也允许用户从显式退出按钮正常返回。
 */
export function FullscreenPanel({
  title,
  children,
  enabled = true,
  buttonLabel = "全屏探索",
  variant = "workbench",
  className = "",
  autoExpandSignal,
  triggerInContent = false,
}: {
  title: string;
  children: ReactNode;
  enabled?: boolean;
  buttonLabel?: string;
  variant?: FullscreenVariant;
  className?: string;
  /**
   * 只响应组件挂载后的信号变化。父组件应在用户明确发起深度操作时递增它；初始值和
   * 会话恢复不会自动打开，用户手动退出后也不会因同一个信号再次进入。
   */
  autoExpandSignal?: number;
  /** The children place the collapsed entry button themselves with {@link FullscreenTriggerSlot}. */
  triggerInContent?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState<number | null>(null);
  const previousAutoExpandSignal = useRef(autoExpandSignal);

  const open = () => {
    setPlaceholderHeight(panelRef.current?.getBoundingClientRect().height ?? null);
    setExpanded(true);
  };
  const close = () => setExpanded(false);

  useEffect(() => {
    const previous = previousAutoExpandSignal.current;
    previousAutoExpandSignal.current = autoExpandSignal;
    if (!enabled || expanded || autoExpandSignal === undefined || autoExpandSignal === previous) return;
    setPlaceholderHeight(panelRef.current?.getBoundingClientRect().height ?? null);
    setExpanded(true);
  }, [autoExpandSignal, enabled, expanded]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="fullscreen-panel-trigger secondary"
      onClick={open}
      aria-label={`${buttonLabel}：${title}`}
    >
      <span aria-hidden="true">↗</span>
      {buttonLabel}
    </button>
  );
  const slotted = triggerInContent && !expanded;

  const panel = (
    <section
      ref={panelRef}
      className={`fullscreen-panel fullscreen-panel--${variant}${expanded ? " fullscreen-panel--expanded" : ""}${className ? ` ${className}` : ""}`}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? "true" : undefined}
      aria-labelledby={expanded ? titleId : undefined}
      aria-describedby={expanded ? descriptionId : undefined}
      tabIndex={expanded || !enabled ? -1 : undefined}
    >
      <div className="fullscreen-panel-surface">
        {expanded ? (
          <div className="fullscreen-panel-bar">
            <strong id={titleId}>{title}</strong>
            <span id={descriptionId} className="sr-only">
              已进入全屏工作区。可继续操作当前内容，或使用“退出全屏”返回步骤页面。
            </span>
            <button
              ref={exitRef}
              type="button"
              className="fullscreen-panel-exit"
              onClick={close}
              aria-label={`退出${title}全屏工作区`}
            >
              <span aria-hidden="true">↙</span>
              退出全屏
            </button>
          </div>
        ) : enabled && !slotted && <div className="fullscreen-panel-bar">{trigger}</div>}
        {/* Focus stays where it was when the panel expands in place, so the dialog itself is not announced;
            a status line says the view changed. */}
        <span className="sr-only" role="status">{expanded ? `已进入${title}全屏工作区，按 Esc 退出。` : ""}</span>
        {expanded && <FullscreenSyncProblem />}
        <div className="fullscreen-panel-content">
          <FullscreenTriggerContext.Provider value={slotted && enabled ? trigger : null}>{children}</FullscreenTriggerContext.Provider>
        </div>
      </div>
    </section>
  );

  return (
    <>
      <div
        className="fullscreen-panel-placeholder"
        style={{ height: placeholderHeight ?? undefined }}
        hidden={!expanded}
        aria-hidden="true"
      />
      {panel}
      {expanded && (
        <FullscreenDialogBehavior
          containerRef={panelRef}
          initialFocusRef={exitRef}
          returnFocusRef={enabled ? triggerRef : panelRef}
          onClose={close}
        />
      )}
    </>
  );
}
