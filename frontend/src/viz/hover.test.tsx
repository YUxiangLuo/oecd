import { afterEach, expect, test } from "bun:test";
import { visibleBounds } from "./hover";

afterEach(() => { document.body.innerHTML = ""; });

function box(className: string, top: number, bottom: number, overflowY = "visible") {
  const node = document.createElement("div");
  node.className = className;
  node.style.overflowY = overflowY;
  node.getBoundingClientRect = () => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  return node;
}

test("the readout stays inside a scrolling box between the chart and the step content", () => {
  const content = box("content", 56, 848, "auto");
  const ranking = box("industry-ranking-box", 329, 683, "auto");
  const plain = box("chart-card", 300, 900);
  const chart = box("chart", 330, 700);
  content.append(plain);
  plain.append(ranking);
  ranking.append(chart);
  document.body.append(content);
  expect(visibleBounds(chart)).toEqual({ top: 329, bottom: 683 });
  // Without a clipping box, the step content bounds it, as before.
  const free = box("chart", 330, 700);
  plain.append(free);
  expect(visibleBounds(free)).toEqual({ top: 56, bottom: Math.min(848, window.innerHeight) });
});
