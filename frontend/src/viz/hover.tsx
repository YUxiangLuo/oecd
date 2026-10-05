/**
 * Shared hover and keyboard readout for the hand-drawn SVG charts.
 *
 * A chart keeps its own "active" state (the year under the crosshair, the hovered mark, the
 * highlighted series) and uses this hook only for the floating readout: `show` follows the
 * pointer, `showFor` anchors to an element for keyboard focus, `hide` clears it. The readout is a
 * polite live region so a keyboard reader hears the same values a mouse user sees. Every value
 * shown here is also in the chart's reading table; the tooltip enhances, it never gates.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";

/** `[label, value, seriesColor?]`; a line with an empty label is the heading. */
export type TipLine = [string, string, string?];

const TIP_WIDTH = 210;

export function useHoverTip() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
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
  const hide = useCallback(() => setTip(null), []);
  const Tip: ReactNode = (
    <div
      className="hover-tip"
      role="status"
      aria-live="polite"
      style={tip ? { left: tip.x, top: tip.y } : { visibility: "hidden" }}
    >
      {tip?.lines.map(([label, value, color], index) =>
        index === 0 && label === "" ? (
          <div key={index} className="hover-tip-head">{value}</div>
        ) : (
          <div key={index}>
            {color && <i className="hover-tip-key" style={{ background: color }} aria-hidden="true" />}
            <span>{label}</span>
            <b>{value}</b>
          </div>
        ),
      )}
    </div>
  );
  return { wrapRef, Tip, show, showFor, hide };
}
