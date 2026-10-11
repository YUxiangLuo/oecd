/**
 * Keep the fixed application shell anchored to the viewport while revealing an element (a freshly calculated
 * verdict, a freshly generated report draft) inside the course's own scroll container.
 * `Element.scrollIntoView()` also scrolls the document in this nested layout, which can move the entire
 * 100vh application off screen.
 */
export function scrollIntoCourseContent(target: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!target) return;
  const scroller = target.closest<HTMLElement>(".content");
  if (!scroller) {
    target.scrollIntoView({ behavior, block: "start" });
    return;
  }
  const top = scroller.scrollTop
    + target.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top, left: 0, behavior });
}

const STUDENT_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Bring a just-focused element to the top of the course scroller and keep it there while the page settles: a step
 * opened from step 15 loads its data after the first frame, and what appears above the element would otherwise push
 * it off screen with the focus still on it. Stops once the student scrolls, clicks or types, focus moves elsewhere,
 * or after `settleMs`; returns the stop function.
 */
export function revealFocusedWhileSettling(target: HTMLElement, settleMs = 4000, offset = 16): () => void {
  const scroller = target.closest<HTMLElement>(".content");
  const align = () => {
    if (!scroller) {
      target.scrollIntoView?.({ block: "start" });
      return;
    }
    const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
    scroller.scrollTo?.({ top: Math.max(0, top), left: 0, behavior: "auto" });
  };
  align();
  const view = target.ownerDocument.defaultView;
  if (!scroller || !view || typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => {
    if (target.isConnected && target.ownerDocument.activeElement === target) align();
    else stop();
  });
  const stop = () => {
    observer.disconnect();
    view.clearTimeout(timer);
    for (const type of STUDENT_INPUT) view.removeEventListener(type, stop, true);
  };
  for (const type of STUDENT_INPUT) view.addEventListener(type, stop, { capture: true, passive: true });
  const timer = view.setTimeout(stop, settleMs);
  for (const child of Array.from(scroller.children)) observer.observe(child);
  return stop;
}
