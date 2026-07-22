import { describe, expect, test } from "bun:test";
import { canFilterSelectedEdges } from "./step8-network";

describe("network selected-edge filter", () => {
  test("未选节点时不允许进入无效筛选状态", () => {
    expect(canFilterSelectedEdges(null)).toBeFalse();
  });

  test("选中节点后开放筛选", () => {
    expect(canFilterSelectedEdges("USA")).toBeTrue();
  });
});
