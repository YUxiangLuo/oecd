import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LengthViz } from "./views/length-comparison";
import { QuadrantScatter } from "./explore/charts";

const rows = [
  { country: "CHN", PLv: 3.2, PLy: 2.4, PLv_GVC: 4.2, PLy_GVC: 3.8, GVCPs: 4.2 / 3.8 },
  { country: "CIV", PLv: 2.8, PLy: 2.9, PLv_GVC: 3.6, PLy_GVC: 3.9, GVCPs: 3.6 / 3.9 },
];
const highlight = new Set(["CHN"]);
function fragment(markup: string) {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
}
// Independent WCAG sRGB relative-luminance calculation for white chart cards.
function whiteContrast(color: string): number {
  const channels = color.startsWith("#")
    ? (color.length === 4 ? color.slice(1).split("").map((v) => v + v) : color.slice(1).match(/../g)!).map((v) => parseInt(v, 16))
    : (color.match(/[\d.]+/g) ?? []).map(Number);
  expect(channels).toHaveLength(3);
  const linear = channels.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 1.05 / (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] + 0.05);
}

test("selected length-country labels and position values meet small-text contrast", () => {
  const root = fragment(renderToStaticMarkup(<LengthViz rows={rows} highlight={highlight} />));
  const selected = root.querySelector('[data-selected="true"]')!;
  for (const index of [0, 2]) {
    expect(whiteContrast((selected.children[index] as HTMLElement).style.color)).toBeGreaterThanOrEqual(4.5);
  }
});

test("length-axis tick labels meet small-text contrast", () => {
  const root = fragment(renderToStaticMarkup(<LengthViz rows={rows} highlight={highlight} />));
  const ticks = Array.from(root.querySelectorAll("span")).filter((node) => /^\d+$/.test(node.textContent ?? ""));
  expect(ticks.length).toBeGreaterThan(1);
  for (const tick of ticks) expect(whiteContrast(tick.style.color)).toBeGreaterThanOrEqual(4.5);
});

test("selected scatter labels meet small-text contrast without changing point colors", () => {
  const root = fragment(renderToStaticMarkup(<QuadrantScatter rows={rows} highlight={highlight} xKey="PLv" yKey="PLy" xLabel="前向" yLabel="后向" />));
  const label = Array.from(root.querySelectorAll("svg text")).find((node) => node.textContent === "CHN")!;
  expect(whiteContrast(label.getAttribute("fill")!)).toBeGreaterThanOrEqual(4.5);
  // Labels sit in their own layer above the points; the selected point keeps its highlight colour, which is
  // not the negative-value red.
  expect(root.querySelector('svg circle[fill="#eda100"]')).not.toBeNull();
  expect(root.querySelector('svg circle[fill="#e34948"]')).toBeNull();
});
