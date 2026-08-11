import { describe, expect, test } from "bun:test";

import { EQUALITY_LINE_LABEL } from "./charts";

function relativeLuminance(color: string): number {
  const channels = color.slice(1).match(/.{2}/g)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const [high, low] = first >= second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

describe("step 9 equality-line legend", () => {
  test("keeps small orange legend text above the WCAG AA contrast floor", () => {
    expect(contrastRatio(EQUALITY_LINE_LABEL, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
