import { expect, test } from "bun:test";
import { normalizeLabel, searchKey } from "./text";

// The server's twin is gvcsim/classroom/routes.py normalize_label (tests/test_input_boundaries.py).
test("labels fold look-alike letters, digits and spaces but keep Chinese full-width punctuation", () => {
  expect(normalizeLabel("2026　秋")).toBe("2026 秋");
  expect(normalizeLabel("﻿ ２０２６秋 ⁠")).toBe("2026秋");
  expect(normalizeLabel("Ａ班\t\n二组")).toBe("A班 二组");
  expect(normalizeLabel("王五（转专业）")).toBe("王五（转专业）");
  expect(normalizeLabel("国贸１班：（二）！")).toBe("国贸1班：（二）！");
  expect(normalizeLabel("é（备注）")).toBe("é（备注）");
});

test("a search folds full-width punctuation too, so names stored either way are found", () => {
  expect(searchKey("王五（")).toBe(searchKey("王五("));
  expect(searchKey("王五(转专业)").includes(searchKey("王五（"))).toBe(true);
  expect(searchKey("王五（转专业）").includes(searchKey("王五("))).toBe(true);
  expect(searchKey("２０２４－００１")).toBe("2024-001");
  expect(searchKey(" ＡＢ​c ")).toBe("abc");
});

test("teacher name keys remove default ignorables and blank-like characters", () => {
  expect(searchKey("\u3164\u115f\u1160\uffa0\u2800\u034f")).toBe("");
  expect(searchKey("Ａ（秋）\ufe0f")).toBe(searchKey("a(秋)"));
  expect(searchKey("ΟΣ")).toBe("οσ");
});

test("a search ignores spaces: “张 三” finds “张三”, “2026秋” finds “2026 秋”", () => {
  expect(searchKey("张 三")).toBe(searchKey("张三"));
  expect(searchKey("2026 秋").includes(searchKey("2026秋"))).toBe(true);
  expect(searchKey("国贸　1 班")).toBe("国贸1班");
});
