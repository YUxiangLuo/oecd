export interface StepScroller {
  scrollTo(options: ScrollToOptions): void;
}

/** A single scroll container is reused across all 16 steps; every step starts at its origin. */
export function resetStepScroller(scroller: StepScroller | null): void {
  scroller?.scrollTo({ top: 0, left: 0, behavior: "auto" });
}
