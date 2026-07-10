/**
 * 轻量成功/提示 toast:showToast() 全局可调,ToastHost 渲染在应用外壳里。
 * 仅用于操作成功等瞬时反馈;错误仍走各处的 error-box 常驻展示。
 */
import { useEffect, useState } from "react";

const TOAST_EVENT = "gvcsim-toast";

export function showToast(message: string) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: message }));
}

interface ToastItem {
  id: number;
  message: string;
}

let nextId = 1;

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const message = String((e as CustomEvent).detail ?? "");
      if (!message) return;
      const id = nextId++;
      setItems((current) => [...current, { id, message }]);
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 2600);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);
  if (!items.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className="toast-item">✓ {item.message}</div>
      ))}
    </div>
  );
}
