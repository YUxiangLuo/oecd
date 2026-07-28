import { useId, useRef, type ReactNode } from "react";
import { useDialogFocus } from "../a11y";

/** 教师面板共用的轻量 UI 原语:模态框 / 工具条 / 搜索框 / 状态徽标 / 空态。
 *  替代原来散落的 window.prompt / window.confirm 与常驻内联表单。 */

/** 居中模态对话框:遮罩点击关闭 + Esc 关闭 + 标题栏。参考 intro.tsx 的 overlay 画法。 */
export function Modal({
  title,
  onClose,
  children,
  width = 420,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus({ containerRef: dialogRef, onClose });
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        ref={dialogRef}
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

/** 确认对话框:危险操作(删除/停用)统一走这里,替代 window.confirm。 */
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
  return (
    <Modal title={title} onClose={onClose} width={380}>
      <p className="modal-msg">{message}</p>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
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

/** 状态徽标:正常/停用、待评阅/已评阅等。 */
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
