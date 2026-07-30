import { describe, expect, test } from "bun:test";
import { canFilterSelectedEdges, nextNetworkNode } from "./step8-network";

describe("network selected-edge filter", () => {
  test("未选节点时不允许进入无效筛选状态", () => {
    expect(canFilterSelectedEdges(null)).toBeFalse();
  });

  test("选中节点后开放筛选", () => {
    expect(canFilterSelectedEdges("USA")).toBeTrue();
  });
});

describe("network keyboard navigation", () => {
  const nodes = ["CHN", "JPN", "USA"];

  test("moves with arrow keys and wraps at both ends", () => {
    expect(nextNetworkNode(nodes, "CHN", "ArrowRight")).toBe("JPN");
    expect(nextNetworkNode(nodes, "USA", "ArrowDown")).toBe("CHN");
    expect(nextNetworkNode(nodes, "CHN", "ArrowLeft")).toBe("USA");
  });

  test("supports Home and End without treating unrelated keys as navigation", () => {
    expect(nextNetworkNode(nodes, "JPN", "Home")).toBe("CHN");
    expect(nextNetworkNode(nodes, "JPN", "End")).toBe("USA");
    expect(nextNetworkNode(nodes, "JPN", "Enter")).toBeNull();
  });
});
