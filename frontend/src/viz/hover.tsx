/**
 * Shared hover and keyboard readout for the hand-drawn SVG charts.
 *
 * A chart keeps its own "active" state (the year under the crosshair, the hovered mark, the
 * highlighted series) and uses this hook only for the floating readout: `show` follows the
 * pointer, `showFor` anchors to an element for keyboard focus, `hide` clears it. The readout is a
 * polite live region so a keyboard reader hears the same values a mouse user sees. Every value
 * shown here is also in the chart's reading table; the tooltip enhances, it never gates.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** `[label, value, seriesColor?, dashed?]`; a line with an empty label is the heading. `dashed` draws the key
 * like a dashed series line, so the readout matches the chart. */
export type TipLine = [string, string, string?, boolean?];

const TIP_WIDTH = 250;

/** The boxes between a chart and the step content that clip what overflows them, then the step content itself
 * (step 6's scrolling industry ranking cut off the readout of its bottom rows). They do not change while a readout
 * moves with the pointer, so the hook looks them up once per chart. */
export function clippingAncestors(element: Element | null): Element[] {
  const found: Element[] = [];
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (node.classList.contains("content")) return [...found, node];
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY)) found.push(node);
  }
  return found;
}

/** The visible part of the page: the window narrowed by the clipping boxes around the chart (the scrolling step
 * content keeps the readout above the fixed step footer). */
export function visibleBounds(element: Element | null, clips = clippingAncestors(element)): { top: number; bottom: number } {
  const bounds = { top: 0, bottom: window.innerHeight || Infinity };
  for (const clip of clips) {
    const rect = clip.getBoundingClientRect();
    if (!rect.height) continue;
    bounds.top = Math.max(bounds.top, rect.top);
    bounds.bottom = Math.min(bounds.bottom, rect.bottom);
  }
  return bounds;
}

export function useHoverTip() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const clipsRef = useRef<{ wrap: Element | null; clips: Element[] }>({ wrap: null, clips: [] });
  const [tip, setTip] = useState<{ x: number; y: number; lines: TipLine[] } | null>(null);
  const place = useCallback((clientX: number, clientY: number, lines: TipLine[]) => {
    const rect = wrapRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0 };
    let x = clientX - rect.left + 14;
    if (rect.width && x > rect.width - TIP_WIDTH) x = clientX - rect.left - TIP_WIDTH - 6;
    setTip({ x: Math.max(0, x), y: Math.max(0, clientY - rect.top + 12), lines });
  }, []);
  /** Pointer events: the readout follows the pointer. */
  const show = useCallback(
    (event: { clientX: number; clientY: number }, lines: TipLine[]) => place(event.clientX, event.clientY, lines),
    [place],
  );
  /** Keyboard focus: the readout sits under the focused element. */
  const showFor = useCallback((element: Element | null, lines: TipLine[]) => {
    const rect = element?.getBoundingClientRect();
    place(rect ? rect.left + rect.width / 2 : 0, rect ? rect.bottom : 0, lines);
  }, [place]);
  /** Keyboard reading inside a large chart (a year on the trend chart): the readout sits beside that mark,
   * near its top, instead of under the whole chart. */
  const showNear = useCallback((element: Element | null, lines: TipLine[]) => {
    const rect = element?.getBoundingClientRect();
    place(rect ? rect.left + rect.width / 2 : 0, rect ? rect.top : 0, lines);
  }, [place]);
  const hide = useCallback(() => setTip(null), []);
  // Keep the readout inside the visible area: one placed below the fold (or under the fixed step footer) moves up.
  useLayoutEffect(() => {
    const box = tipRef.current;
    if (!tip || !box) return;
    const rect = box.getBoundingClientRect();
    if (!rect.height) return;
    if (clipsRef.current.wrap !== wrapRef.current) clipsRef.current = { wrap: wrapRef.current, clips: clippingAncestors(wrapRef.current) };
    const bounds = visibleBounds(wrapRef.current, clipsRef.current.clips);
    const overflow = rect.bottom - (bounds.bottom - 4);
    if (overflow <= 0) return;
    const room = rect.top - (bounds.top + 4);
    box.style.top = `${tip.y - Math.max(0, Math.min(overflow, room))}px`;
  }, [tip]);
  // Escape dismisses a readout that covers content (WCAG 1.4.13), on every chart that uses this hook.
  const shown = tip !== null;
  useEffect(() => {
    if (!shown) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setTip(null); };
    // A window resize moves the chart under the readout's pixel position: it would sit off the chart (and widen
    // the page), so it closes; the next pointer move or key shows it again in place.
    const resize = () => setTip(null);
    document.addEventListener("keydown", dismiss);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.removeEventListener("resize", resize);
    };
  }, [shown]);
  const Tip: ReactNode = (
    <div
      ref={tipRef}
      className="hover-tip"
      role="status"
      aria-live="polite"
      style={tip ? { left: tip.x, top: tip.y } : { visibility: "hidden" }}
    >
      {tip?.lines.map(([label, value, color, dashed], index) =>
        index === 0 && label === "" ? (
          <div key={index} className="hover-tip-head">{value}</div>
        ) : (
          <div key={index}>
            {color && <i className="hover-tip-key" style={{ background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color }} aria-hidden="true" />}
            <span>{label}</span>
            <b>{value}</b>
          </div>
        ),
      )}
    </div>
  );
  return { wrapRef, Tip, show, showFor, showNear, hide };
}
