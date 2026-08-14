import { describe, expect, test } from "bun:test";
import { addInspectedCountry } from "../../labs/steps/viz/scaffold";
import { networkNodeActivation, nextNetworkNode } from "./step8-network";

describe("network fullscreen activation", () => {
  test("an inline node always opens the large view with that node selected", () => {
    expect(networkNodeActivation(null, "CHN", false)).toEqual({ selected: "CHN", expanded: true });
    expect(networkNodeActivation("CHN", "CHN", false)).toEqual({ selected: "CHN", expanded: true });
  });

  test("node selection can change or clear without closing the large view", () => {
    expect(networkNodeActivation("CHN", "USA", true)).toEqual({ selected: "USA", expanded: true });
    expect(networkNodeActivation("CHN", "CHN", true)).toEqual({ selected: null, expanded: true });
  });

  test("inspecting a node adds it to the comparison list; clearing does not drop it", () => {
    const allowed = ["CHN", "USA", "DEU"];
    const afterOpen = networkNodeActivation(null, "CHN", false).selected;
    expect(afterOpen).toBe("CHN");
    const picked = addInspectedCountry([], afterOpen!, allowed);
    const afterSwitch = networkNodeActivation("CHN", "USA", true).selected;
    expect(addInspectedCountry(picked, afterSwitch!, allowed)).toEqual(["CHN", "USA"]);
    const afterClear = networkNodeActivation("USA", "USA", true).selected;
    expect(afterClear).toBeNull();
    expect(addInspectedCountry(["CHN", "USA"], afterClear ?? "", allowed)).toEqual(["CHN", "USA"]);
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
