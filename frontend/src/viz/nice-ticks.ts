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
