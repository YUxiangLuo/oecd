import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { keepFocusNear, useDialogFocus } from "../a11y";
import { userFacingRequestError } from "../user-facing-error";

/** 教师面板共用的轻量 UI 原语:模态框 / 工具条 / 搜索框 / 状态徽标 / 空态。
 *  替代原来散落的 window.prompt / window.confirm 与常驻内联表单。 */

/** 居中模态对话框:遮罩点击关闭 + 关闭按钮 + 标题栏。参考 intro.tsx 的 overlay 画法。 */
export function Modal({
  title,
  onClose,
  children,
  width = 420,
  initialFocusRef,
  returnFocusRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Form dialogs open with the first field focused, not the close button; dialogs without fields keep the default.
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const attachDialog = (node: HTMLDivElement | null) => {
    dialogRef.current = node;
    firstFieldRef.current = node?.querySelector<HTMLElement>(
      ".modal-body input:not([type=hidden]):not([disabled]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])",
    ) ?? null;
  };
  useDialogFocus({ containerRef: dialogRef, initialFocusRef: initialFocusRef ?? firstFieldRef, returnFocusRef, onClose });
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        ref={attachDialog}
        className="modal-card"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <b id={titleId}>{title}</b>
          <button className="modal-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** 确认对话框:删除等危险操作统一走这里,替代 window.confirm。 */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "确认",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // Open on 取消, the safe choice (not the × in the corner).
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal title={title} onClose={onClose} width={380} initialFocusRef={cancelRef}>
      <p className="modal-msg">{message}</p>
      <div className="modal-actions">
        <button ref={cancelRef} onClick={onClose}>取消</button>
        <button
          className={danger ? "danger" : "primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Move focus to a form error when it appears (the submit button was disabled while saving, so focus was lost). */
export function useModalErrorFocus(error: string | null) {
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return errorRef;
}

/** A list that failed to load: Chinese copy for transport errors (not the browser's "Failed to fetch") and a retry. */
export function LoadFailure({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div className="error-box async-error" role="alert">
      <span>{userFacingRequestError(error, `${what}加载失败`)}</span>
      <button type="button" className="secondary" onClick={(event) => { const button = event.currentTarget; onRetry(); keepFocusNear(button); }}>重试</button>
    </div>
  );
}

/** Call `onVisible` whenever the tab becomes visible again (the teacher comes back from another tab or window). */
export function useRefetchOnVisible(onVisible: () => void, enabled = true) {
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    if (!enabled) return;
    const listener = () => {
      if (document.visibilityState === "visible") callback.current();
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, [enabled]);
}

/** 页面工具条:左侧筛选/搜索,右侧操作按钮。 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
  label = "搜索",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="search-input">
      <span className="search-ic">🔍</span>
      <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {value && (
        <button className="search-clear" onClick={() => onChange("")} aria-label="清除">
          ×
        </button>
      )}
    </div>
  );
}

type PillTone = "ok" | "info" | "warn" | "muted";

/** 状态徽标:待评阅/已评阅等。 */
export function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

export function EmptyState({
  icon = "📭",
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-ic">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action}
    </div>
  );
}
