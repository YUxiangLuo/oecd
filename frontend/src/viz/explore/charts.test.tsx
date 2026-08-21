import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LengthViz } from "../steps/step10-length";
import { CompositionBar, QuadrantScatter, RankBarChart } from "./charts";

const rows = [
  { country: "AAA", metric: 0.25, x: 1.25, y: 2.5, a: 4, b: -1, total: 9 },
  { country: "BBB", metric: 0.5, x: 3.75, y: 4.5, a: 2, b: 3, total: 12 },
];

describe("Steps 7-9 chart semantic data equivalents", () => {
  test("rank table contains every plotted entity and identically formatted metric", () => {
    const html = renderToStaticMarkup(
      <RankBarChart rows={rows} metricKey="metric" label="测试份额" format="pct" />,
    );
    expect(html).toContain("查看测试份额排序图表数据表");
    expect(html).toContain("测试份额排序图表所绘制的完整数据");
    expect(html).toContain('<th scope="row">BBB</th><td>50.00%</td>');
    expect(html).toContain('<th scope="row">AAA</th><td>25.00%</td>');
    expect(html).not.toContain("tabindex=\"0\" aria-label=\"AAA");
  });

  test("rank selection remains visibly marked while using the same rows in its semantic table", () => {
    const html = renderToStaticMarkup(
      <RankBarChart
        rows={[{ country: "TOP", metric: 2 }, { country: "SELECTED", metric: -1 }]}
        metricKey="metric"
        label="含符号指标"
        highlight={new Set(["SELECTED"])}
      />,
    );
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('<th scope="row">SELECTED</th><td>-1.000</td>');
  });

  test("scatter table contains every plotted entity and both exact coordinates", () => {
    const html = renderToStaticMarkup(
      <QuadrantScatter rows={rows} xKey="x" yKey="y" xLabel="横轴指标" yLabel="纵轴指标" xFormat="number" yFormat="number" />,
    );
    expect(html).toContain("查看纵轴指标与横轴指标散点图表数据表");
    expect(html).toContain("<th scope=\"col\">横轴指标</th>");
    expect(html).toContain("<th scope=\"col\">纵轴指标</th>");
    expect(html).toContain('<th scope="row">AAA</th><td>1.250</td><td>2.500</td>');
    expect(html).toContain('<th scope="row">BBB</th><td>3.750</td><td>4.500</td>');
    expect(html).not.toMatch(/<g[^>]*tabindex=/);
  });

  test("composition table exposes signed segments and a distinct sort metric", () => {
    const html = renderToStaticMarkup(
      <CompositionBar
        rows={rows}
        segments={[{ key: "a", name: "国内段" }, { key: "b", name: "外国段" }]}
        sortKey="total"
        sortLabel="排序总量"
        sortFormat="amount"
        valueFormat="amount"
      />,
    );
    expect(html).toContain("查看排序总量 构成图表数据表");
    expect(html).toContain("<th scope=\"col\">国内段</th>");
    expect(html).toContain("<th scope=\"col\">外国段</th>");
    expect(html).toContain("<th scope=\"col\">排序总量</th>");
    expect(html).toContain('<th scope="row">AAA</th><td>4</td><td>-1</td><td>9</td>');
    expect(html).toContain("composition-chart-track");
  });

  test("length table contains all five metrics for the exact plotted Top-15 rows", () => {
    const html = renderToStaticMarkup(<LengthViz rows={[
      { country: "AAA", PLv: 3.2, PLv_GVC: 2.1, PLy: 2.8, PLy_GVC: 1.7, GVCPs: 1.235 },
      { country: "BBB", PLv: 2.4, PLv_GVC: 1.4, PLy: 3.1, PLy_GVC: 2.2, GVCPs: 0.636 },
    ]} />);
    for (const header of ["前向总长度 PLv", "前向 GVC 段 PLv_GVC", "后向总长度 PLy", "后向 GVC 段 PLy_GVC", "位置指数 GVCPs"]) {
      expect(html).toContain(header);
    }
    expect(html).toContain('<th scope="row">AAA</th><td>3.200</td><td>2.100</td><td>2.800</td><td>1.700</td><td>1.235</td>');
    expect(html).toContain('<th scope="row">BBB</th><td>2.400</td><td>1.400</td><td>3.100</td><td>2.200</td><td>0.636</td>');
  });

  test("length Top 15 + selected uses one deduplicated highlighted collection for bars and table", () => {
    const ranked = Array.from({ length: 16 }, (_, index) => ({
      country: `C${String(index).padStart(2, "0")}`,
      PLv: 30 - index,
      PLv_GVC: 2,
      PLy: 3,
      PLy_GVC: 2,
      GVCPs: 1,
    }));
    const selected = { country: "OUT", PLv: 1, PLv_GVC: 2, PLy: 3, PLy_GVC: 2, GVCPs: 1 };
    const html = renderToStaticMarkup(
      <LengthViz rows={[...ranked, selected, { ...selected, PLv: 0.5 }]} highlight={new Set(["OUT"])} />,
    );
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(html.match(/>OUT</g)).toHaveLength(2);
    expect(html).toContain('<th scope="row">OUT</th><td>1.000</td>');
    expect(html).toContain("Top 15 + 已选国家");
  });

  test("required-field nulls produce explicit chart empty states without fabricated zero text", () => {
    const outputs = [
      renderToStaticMarkup(<RankBarChart rows={[{ country: "A", metric: null }]} metricKey="metric" label="空排名" />),
      renderToStaticMarkup(<QuadrantScatter rows={[{ country: "A", x: null, y: 2 }]} xKey="x" yKey="y" xLabel="横轴" yLabel="纵轴" />),
      renderToStaticMarkup(<CompositionBar rows={[{ country: "A", total: 3, a: null }]} segments={[{ key: "a", name: "分段" }]} sortKey="total" />),
      renderToStaticMarkup(<LengthViz rows={[{ country: "A", PLv: 2, PLv_GVC: null, PLy: 2, PLy_GVC: 2, GVCPs: 1 }]} />),
    ];
    for (const html of outputs) {
      expect(html).toContain('role="status"');
      expect(html).toContain("当前没有");
      expect(html).not.toContain("0.000");
      expect(html).not.toContain("<table");
    }
  });

  test("composition layout reserves a useful non-collapsing bar track", async () => {
    const css = await Bun.file(new URL("../../styles.css", import.meta.url)).text();
    expect(css).toContain("grid-template-columns: minmax(112px, 128px) minmax(120px, 1fr) 72px");
    expect(css).toContain(".composition-chart-track { min-width: 120px; }");
  });

  test("empty chart input exposes a named empty state rather than an unnamed table", () => {
    for (const html of [
      renderToStaticMarkup(<RankBarChart rows={[]} metricKey="metric" label="空排名" />),
      renderToStaticMarkup(<QuadrantScatter rows={[]} xKey="x" yKey="y" xLabel="横轴" yLabel="纵轴" />),
      renderToStaticMarkup(<CompositionBar rows={[]} segments={[{ key: "a", name: "分段" }]} />),
      renderToStaticMarkup(<LengthViz rows={[]} />),
    ]) {
      expect(html).toContain("当前没有可显示的有效数据");
      expect(html).not.toContain("<table");
      expect(html).toContain("<summary>");
    }
  });
});
