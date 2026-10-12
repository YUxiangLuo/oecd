import { expect, test } from "bun:test";
import fixtures from "../../tests/fixtures/name_keys.json";
import { nameKey } from "./name-keys";
import { nameProblem, nextResultName } from "./regression-workbench-table";

test("shared backend/frontend comparison keys, including non-casefold and contextual casing", () => {
  for (const [name, key] of fixtures) expect(nameKey(name!)).toBe(key!);
});

test("empty comparison keys and lone surrogates are not model names", () => {
  for (const name of ["\u3164", "\u115f", "\u1160", "\uffa0", "\u2800", "\u034f"]) {
    expect(nameProblem(name, [], 20)).toBe("请输入名称");
  }
  expect(nameProblem("\ud800", [], 20)).not.toBeNull();
  expect(nameProblem("👩🏽‍💻", [], 20)).toBeNull();
});

test("generated result names avoid normalized conflicts", () => {
  expect(nextResultName([{ name: "结果２\ufe0f" }])).toBe("结果3");
  expect(nameProblem("Ａ：（二）", [{ id: "1", name: "a:(二)" }], 20)).not.toBeNull();
});
