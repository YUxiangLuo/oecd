/**
 * 轻量成功/提示 toast:showToast() 全局可调,ToastHost 渲染在应用外壳里。
 * 仅用于操作成功等瞬时反馈;错误仍走各处的 error-box 常驻展示。
 */
import { useEffect, useState } from "react";

const TOAST_EVENT = "gvcsim-toast";
const CLEAR_TOASTS_EVENT = "gvcsim-clear-toasts";

/** "success" confirms a finished action (✓); "info" explains why nothing happened (ⓘ), so a refusal never looks like success. */
export type ToastTone = "success" | "info";

export function showToast(message: string, tone: ToastTone = "success") {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }));
}

export function clearToasts() {
  window.dispatchEvent(new Event(CLEAR_TOASTS_EVENT));
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

let nextId = 1;

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string; tone?: ToastTone }>).detail ?? {};
      const message = String(detail.message ?? "");
      if (!message) return;
      const id = nextId++;
      setItems((current) => [...current, { id, message, tone: detail.tone === "info" ? "info" : "success" }]);
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 2600);
    };
    const onClear = () => setItems([]);
    window.addEventListener(TOAST_EVENT, onToast);
    window.addEventListener(CLEAR_TOASTS_EVENT, onClear);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      window.removeEventListener(CLEAR_TOASTS_EVENT, onClear);
    };
  }, []);
  if (!items.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast-item${item.tone === "info" ? " toast-item--info" : ""}`}>
          {item.tone === "info" ? "ⓘ" : "✓"} {item.message}
        </div>
      ))}
    </div>
  );
}
