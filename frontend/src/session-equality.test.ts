import { expect, test } from "bun:test";
import { emptySession, patchStep, sameSessionContent } from "./session-store";

const withValue = (value: unknown) => patchStep(emptySession(), 8, { value });

test("session equality ignores JSON object-key order, not array order", () => {
  expect(sameSessionContent(withValue({ year: 2020, countries: ["CHN", "CIV"] }), withValue({ countries: ["CHN", "CIV"], year: 2020 }))).toBe(true);
  expect(sameSessionContent(withValue(["CHN", "CIV"]), withValue(["CIV", "CHN"]))).toBe(false);
  expect(sameSessionContent(withValue([]), withValue({}))).toBe(false);
});

test("session equality preserves value types, nulls, deletions and signed values", () => {
  for (const [first, second] of [[true, 1], ["0", 0], [null, 0], [1, -1], [{ a: 1 }, {}], [{ a: null }, {}]]) {
    expect(sameSessionContent(withValue(first), withValue(second))).toBe(false);
  }
  expect(sameSessionContent(withValue({ a: undefined }), withValue({}))).toBe(true);
});

test("a genuinely new step remains material even when its first patch is empty", () => {
  const initial = emptySession();
  expect(sameSessionContent(initial, patchStep(initial, 8, {}))).toBe(false);
  expect(sameSessionContent(initial, initial)).toBe(true);
});
