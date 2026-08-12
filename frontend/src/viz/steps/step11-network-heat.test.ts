import { describe, expect, test } from "bun:test";
import { SEQ } from "../shared";
import { heatTextColor } from "./step11-network-heat";

function relativeLuminance(color: string): number {
  const hex = color.length === 4
    ? [...color.slice(1)].map((digit) => digit.repeat(2))
    : [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)];
  const [red, green, blue] = hex.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("network heat table contrast", () => {
  test("uses dark text on the mid-blue cell that fails with white text", () => {
    expect(heatTextColor(3)).toBe("#1b1f2b");
    expect(heatTextColor(4)).toBe("#fff");
  });

  test("every actual sequential palette cell meets WCAG AA text contrast", () => {
    for (const [index, background] of SEQ.entries()) {
      expect(contrastRatio(background, heatTextColor(index))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
