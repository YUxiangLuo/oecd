/** Reveal the current outline item without scrolling the course or stealing focus. */
export function revealOutlineStep(scroller: HTMLElement | null): void {
  const active = scroller?.querySelector<HTMLElement>('[aria-current="step"]');
  if (!scroller || !active) return;
  const viewport = scroller.getBoundingClientRect();
  const row = active.getBoundingClientRect();
  if (row.top < viewport.top) scroller.scrollTop += row.top - viewport.top;
  else if (row.bottom > viewport.bottom) scroller.scrollTop += row.bottom - viewport.bottom;
}

export interface StepScroller {
  scrollTo(options: ScrollToOptions): void;
}

/** A single scroll container is reused across all 15 steps; every step starts at its origin. */
export function resetStepScroller(scroller: StepScroller | null): void {
  scroller?.scrollTo({ top: 0, left: 0, behavior: "auto" });
}
