/**
 * Readable axis domain: expand [lo, hi] outward to multiples of a 1 / 2 / 2.5 / 5 × 10ⁿ step,
 * so tick labels read 0, 2.5, 5… instead of 0, 3.125, 6.25… (data max ÷ 4).
 */
export function niceDomain(lo: number, hi: number, intervals = 4): { lo: number; hi: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  const raw = (hi - lo) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  // Candidate steps around the classic choice; the one wasting least room outside the data wins (ties: fewer
  // ticks). A tiny negative value then costs one small step below zero instead of a step of half the range
  // (−0.3% … 103% used to become −50% … 150%).
  const candidates = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map((factor) => factor * magnitude);
  let best: { lo: number; hi: number; step: number; count: number } | null = null;
  for (const step of candidates) {
    // Tolerances keep a value already on a step (e.g. hi = 12.5) from growing by one extra step.
    const niceLo = Math.floor(lo / step + 1e-9) * step;
    const niceHi = Math.ceil(hi / step - 1e-9) * step;
    const count = Math.round((niceHi - niceLo) / step);
    if (count < Math.max(2, intervals - 1) || count > intervals + 3) continue;
    const waste = (niceHi - niceLo) - (hi - lo);
    if (!best || waste < (best.hi - best.lo) - (hi - lo) - 1e-12 * step
      || (Math.abs(waste - ((best.hi - best.lo) - (hi - lo))) <= 1e-12 * step && count < best.count)) {
      best = { lo: niceLo, hi: niceHi, step, count };
    }
  }
  const chosen = best ?? (() => {
    const normalized = raw / magnitude;
    const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
    const niceLo = Math.floor(lo / step + 1e-9) * step;
    const niceHi = Math.ceil(hi / step - 1e-9) * step;
    return { lo: niceLo, hi: niceHi, step, count: Math.round((niceHi - niceLo) / step) };
  })();
  const ticks = Array.from({ length: chosen.count + 1 }, (_, index) => Number((chosen.lo + index * chosen.step).toPrecision(12)));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
}

/**
 * Whole-number metrics (link counts, path lengths): ticks only on integers. A narrow range would otherwise get
 * quarter steps that read "2, 2, 3, 3, 3" once rounded, and 0–10 would get 2.5 steps that read "0, 3, 5, 8, 10".
 */
export function integerDomain(lo: number, hi: number, intervals = 4): { lo: number; hi: number; ticks: number[] } {
  const nice = niceDomain(lo, hi, intervals);
  if (nice.ticks.every((tick) => Number.isInteger(tick)) || !Number.isFinite(lo) || !Number.isFinite(hi)) return nice;
  if (hi < lo) [lo, hi] = [hi, lo];
  // The smallest whole step that keeps the tick count readable.
  const step = [1, 2, 5, 10].find((candidate) => Math.ceil(hi / candidate) - Math.floor(lo / candidate) <= intervals + 3) ?? 10;
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.max(Math.ceil(hi / step) * step, niceLo + step);
  const ticks = Array.from({ length: Math.round((niceHi - niceLo) / step) + 1 }, (_, index) => niceLo + index * step);
  return { lo: niceLo, hi: niceHi, ticks };
}

/** A step of 1, 2, 2.5 or 5 × 10ⁿ. */
function isNiceStep(step: number): boolean {
  const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  return [1, 2, 2.5, 5, 10].some((nice) => Math.abs(mantissa - nice) < 1e-6);
}

/**
 * The axis of a diverging bar chart (steps 11–15 pages and the report): its range from the data alone (0 and every
 * bar and whisker end, in two to five nice steps), so the page at any width, the report and its print show the same
 * range. Only the tick density follows the room: the range's step split (or joined) into another nice step that
 * lands on both ends, as many as fit `intervals` (at least the coarsest such step).
 */
export function divergingAxis(values: number[], intervals: number): { lo: number; hi: number; ticks: number[] } {
  const finite = values.filter((value) => Number.isFinite(value));
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite) > lo ? Math.max(0, ...finite) : lo + (Math.abs(lo) || 1);
  // The narrowest range on a nice step with two to six steps (ties: fewer steps); 0 is always on a step.
  const magnitude = 10 ** Math.floor(Math.log10(hi - lo));
  let range = { lo, hi, step: hi - lo, count: 1 };
  let bestWidth = Infinity;
  for (const factor of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10]) {
    const step = factor * magnitude;
    const niceLo = Math.floor(lo / step + 1e-9) * step;
    const niceHi = Math.ceil(hi / step - 1e-9) * step;
    const count = Math.round((niceHi - niceLo) / step);
    if (count < 2 || count > 6) continue;
    const width = niceHi - niceLo;
    if (width < bestWidth - 1e-9 * step || (Math.abs(width - bestWidth) <= 1e-9 * step && count < range.count)) {
      range = { lo: niceLo, hi: niceHi, step, count };
      bestWidth = width;
    }
  }
  // Ticks: the range's step split (or joined) into another nice step that still lands on both ends and on 0, as
  // many as fit `intervals`, else the fewest.
  const onStep = (value: number, step: number) => Math.abs(value / step - Math.round(value / step)) < 1e-6;
  const options = [
    ...[1, 2, 4, 5, 10].map((parts) => ({ step: range.step / parts, count: range.count * parts })),
    ...[2, 3, 4, 5, 6].filter((join) => range.count % join === 0).map((join) => ({ step: range.step * join, count: range.count / join })),
  ].filter((option) => isNiceStep(option.step) && onStep(range.lo, option.step));
  const fitting = options.filter((option) => option.count <= Math.max(2, intervals));
  const chosen = fitting.length
    ? fitting.reduce((best, option) => (option.count > best.count ? option : best))
    : options.reduce((best, option) => (option.count < best.count ? option : best), { step: range.step, count: range.count });
  const first = Math.round(range.lo / chosen.step);
  const ticks = Array.from({ length: chosen.count + 1 }, (_, index) => Number(((first + index) * chosen.step).toPrecision(12)));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
}
