import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HeatTableViz } from "./network-heat";

test("the heat table marks an undefined closeness in its cell and adds no separate note about it", () => {
  const rows = [
    { country: "LUX", industry: "C26", "weighted degree": 50, betweenesscentrality: 3, closnesscentrality: 0.4, harmonicclosnesscentrality: 0.5, eigencentrality: 0.1 },
    { country: "LUX", industry: "T", "weighted degree": 0, betweenesscentrality: 0, closnesscentrality: 0, harmonicclosnesscentrality: 0, eigencentrality: 0 },
  ];
  const html = renderToStaticMarkup(<HeatTableViz rows={rows} schema={null} sortMetric="betweenesscentrality" coverage="all" countryName="LUX 卢森堡" />);
  expect(html.match(/data-metric-undefined="true"/g)).toHaveLength(2);
  expect(html).toContain("颜色深浅表示该列可见行中的相对大小");
  expect(html).not.toContain("没有定义（不是 0）");
});
