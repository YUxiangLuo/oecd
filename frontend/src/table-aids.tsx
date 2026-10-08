/**
 * Small aids for the wide data tables of steps 1 and 5: a column ⓘ that keyboard and screen-reader users can
 * read (not only a mouse `title`), and the measured width of a sticky first column, so a second sticky column
 * or a sticky band label can sit right after it.
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cjkJoin } from "./format";

const TIP_WIDTH = 280;

/**
 * A focusable ⓘ after a column name. Its text is the button's accessible description, and it shows as a small
 * box while the button is focused or hovered (a tap focuses it on touch screens). Escape is left alone: inside a
 * fullscreen table it closes the fullscreen, and moving focus away hides the box anyway.
 */
export function ColumnInfo({ label, text }: { label: string; text: string }) {
  const tipId = `column-info-${useId().replaceAll(":", "")}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = typeof window === "undefined" ? TIP_WIDTH + 16 : window.innerWidth;
    setPlace({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, viewport - TIP_WIDTH - 8)) });
  };
  const hideUnlessFocused = () => {
    if (typeof document !== "undefined" && document.activeElement === buttonRef.current) return;
    setPlace(null);
  };

  const tip = (
    <span
      id={tipId}
      role="tooltip"
      className={place ? "column-info-tip" : "sr-only"}
      style={place ? {
        position: "fixed", top: place.top, left: place.left, zIndex: 120, maxWidth: TIP_WIDTH,
        padding: "7px 10px", borderRadius: 8, background: "#242938", color: "#fff",
        fontSize: 12, fontWeight: 400, lineHeight: 1.5, textAlign: "left", whiteSpace: "normal",
        boxShadow: "0 6px 20px rgba(10, 14, 30, 0.25)", pointerEvents: "none",
      } : undefined}
    >
      {text}
    </span>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="column-info"
        aria-label={cjkJoin(label, "的说明")}
        aria-describedby={tipId}
        onFocus={show}
        onBlur={() => setPlace(null)}
        onMouseEnter={show}
        onMouseLeave={hideUnlessFocused}
        // A click inside a header must not reach a sortable header or a cell handler.
        onClick={(event) => { event.stopPropagation(); show(); }}
        style={{
          marginLeft: 3, padding: "0 2px", border: 0, borderRadius: 4, background: "transparent",
          color: "inherit", font: "inherit", lineHeight: 1, cursor: "help",
        }}
      >
        ⓘ
      </button>
      {/* While shown, the box is portalled out of the sticky header so the scroll box and its stacking order
          cannot clip it; while hidden it stays in place as the button's description. */}
      {place && typeof document !== "undefined" ? createPortal(tip, document.body) : tip}
    </>
  );
}

/** The rendered width of an element (0 until measured, and in a DOM without layout). */
export function useMeasuredWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
