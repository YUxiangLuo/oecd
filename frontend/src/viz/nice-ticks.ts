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
  const normalized = raw / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  // Tolerances keep a value already on a step (e.g. hi = 12.5) from growing by one extra step.
  const niceLo = Math.floor(lo / step + 1e-9) * step;
  const niceHi = Math.ceil(hi / step - 1e-9) * step;
  const count = Math.round((niceHi - niceLo) / step);
  const ticks = Array.from({ length: count + 1 }, (_, index) => Number((niceLo + index * step).toPrecision(12)));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
}
