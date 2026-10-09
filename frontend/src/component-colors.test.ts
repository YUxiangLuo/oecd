import { describe, expect, test } from "bun:test";
import { DECOMP, PLY_DECOMP } from "./demos";
import { PRODUCTION_TOPIC } from "./labs/steps/viz/production";
import { TRADE_TOPIC } from "./labs/steps/viz/trade";
import { NEGATIVE_COMPOSITION_STYLE } from "./viz/explore/charts";
import { COMPONENT_COLORS } from "./viz/shared";

/* Round 21: a component keeps one colour from the step that defines it (2–4) to the step that charts it (6–8). */
describe("decomposition components keep one colour across steps", () => {
  const colorsOf = (parts: readonly { key: string; color?: string }[]) => parts.map((part) => [part.key, part.color]);

  test("step 2 and step 6: the six export parts", () => {
    expect(colorsOf(DECOMP[4].parts)).toEqual(colorsOf(TRADE_TOPIC.composition!.segments));
  });

  test("step 3 and step 7: the four production activities, forward and backward", () => {
    const step3 = DECOMP[5].parts.map((part) => part.color);
    expect(PRODUCTION_TOPIC.composition!.segments.map((segment) => segment.color)).toEqual(step3);
    expect(PRODUCTION_TOPIC.composition!.alternate!.segments.map((segment) => segment.color)).toEqual(step3);
  });

  test("step 4: 纯国内 and 传统贸易 read as in step 3, on both the forward and the backward bar", () => {
    for (const parts of [DECOMP[6].parts, PLY_DECOMP.parts]) {
      expect(parts.map((part) => part.color)).toEqual([COMPONENT_COLORS.domestic, COMPONENT_COLORS.traditional, COMPONENT_COLORS.gvc]);
    }
    expect(DECOMP[5].parts[0].color).toBe(COMPONENT_COLORS.domestic);
    expect(DECOMP[5].parts[1].color).toBe(COMPONENT_COLORS.traditional);
  });

  test("no component is drawn in the negative-part red", () => {
    expect(Object.values(COMPONENT_COLORS)).not.toContain(NEGATIVE_COMPOSITION_STYLE.color);
    expect(new Set(Object.values(COMPONENT_COLORS).slice(0, 6)).size).toBe(6);
  });
});
