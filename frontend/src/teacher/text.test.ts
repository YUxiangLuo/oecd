import { expect, test } from "bun:test";
import { normalizeLabel } from "./text";

// The server's twin is gvcsim/classroom/routes.py normalize_label (tests/test_input_boundaries.py).
test("labels fold look-alike letters, digits and spaces but keep Chinese full-width punctuation", () => {
  expect(normalizeLabel("2026　秋")).toBe("2026 秋");
  expect(normalizeLabel("﻿ ２０２６秋 ⁠")).toBe("2026秋");
  expect(normalizeLabel("Ａ班\t\n二组")).toBe("A班 二组");
  expect(normalizeLabel("王五（转专业）")).toBe("王五（转专业）");
  expect(normalizeLabel("国贸１班：（二）！")).toBe("国贸1班：（二）！");
  expect(normalizeLabel("é（备注）")).toBe("é（备注）");
});
