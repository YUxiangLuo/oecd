import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LengthViz } from "../views/length-comparison";
import { CompositionBar, QuadrantScatter, RankBarChart, RANK_HIGHLIGHT_TEXT, xTickAnchor } from "./charts";

function contrastOnWhite(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

const rows = [
  { country: "AAA", metric: 0.25, x: 1.25, y: 2.5, a: 4, b: -1, total: 9 },
  { country: "BBB", metric: 0.5, x: 3.75, y: 4.5, a: 2, b: 3, total: 12 },
];

describe("Steps 6-9 chart semantic data equivalents", () => {
  test("composition preserves year order and uses the authoritative denominator", () => {
    const html = renderToStaticMarkup(<CompositionBar
      rows={[{ country: "2019", a: 20, total: 100 }, { country: "2020", a: 60, total: 200 }]}
      segments={[{ key: "a", name: "分项" }]} sortKey="total" sortDirection="input" normalizationKey="total"
    />);
    expect(html.indexOf('title="2019"')).toBeLessThan(html.indexOf('title="2020"'));
    expect(html).toContain("width:20%");
    expect(html).toContain("width:30%");
  });

  test("rank table contains every plotted entity and identically formatted metric", () => {
    const html = renderToStaticMarkup(
      <RankBarChart rows={rows} metricKey="metric" label="测试份额" format="pct" />,
    );
    expect(html).toContain("查看测试份额排序图表数据表");
    expect(html).toContain("测试份额排序图表所绘制的完整数据");
    expect(html).toContain('<th scope="row">BBB</th><td>50.000%</td>');
    expect(html).toContain('<th scope="row">AAA</th><td>25.000%</td>');
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
    expect(html).toContain(`color:${RANK_HIGHLIGHT_TEXT}`);
    expect(contrastOnWhite(RANK_HIGHLIGHT_TEXT)).toBeGreaterThanOrEqual(4.5);
    expect(html).toContain('<th scope="row">SELECTED</th><td>-1</td>');
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

  test("scatter medians and quadrants need five distinct points, not just five economies", () => {
    const quadrants: [string, string, string, string] = ["右上", "左上", "左下", "右下"];
    const scatter = (points: { country: string; x: number; y: number }[]) => renderToStaticMarkup(
      <QuadrantScatter rows={points} xKey="x" yKey="y" xLabel="横轴指标" yLabel="纵轴指标" quadrantLabels={quadrants} />,
    );
    const economies = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"];
    // Step 7 with T: every economy at 0%, 0%.
    const same = scatter(economies.map((country) => ({ country, x: 0, y: 0 })));
    expect(same).not.toContain('stroke-dasharray="4 4"');
    expect(same).not.toContain("右上");
    expect(same).toContain("图上 6 个点的读数相同，不画中位数和象限。");
    const spread = scatter(economies.map((country, i) => ({ country, x: i, y: i * 2 })));
    expect(spread).toContain('stroke-dasharray="4 4"');
    expect(spread).toContain("右上");
    expect(spread).not.toContain("不画中位数");
  });

  test("step 8 定位图: the equal-length line does not run through a corner label", () => {
    const quadrants: [string, string, string, string] = ["前后向均较高", "前向较高·后向较低", "前后向均较低", "前向较低·后向较高"];
    // Both axes on the same range: the line runs corner to corner.
    const points = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((country, i) => ({ country, x: 1 + i, y: 6 - i }));
    const html = renderToStaticMarkup(
      <QuadrantScatter rows={points} xKey="x" yKey="y" xLabel="后向" yLabel="前向" xFormat="number" yFormat="number" equalityLine quadrantLabels={quadrants} />,
    );
    const label = (corner: number) => {
      const match = html.match(new RegExp(`<text data-corner="${corner}" x="([\\d.]+)" y="([\\d.]+)"`))!;
      return { x: Number(match[1]), y: Number(match[2]) };
    };
    // The line meets the top-right and bottom-left corners: those labels move out of its way; the others stay put.
    expect(label(0)).not.toEqual({ x: 636, y: 26 });
    expect(label(2)).not.toEqual({ x: 68, y: 346 });
    expect(label(1)).toEqual({ x: 68, y: 26 });
    expect(label(3)).toEqual({ x: 636, y: 346 });
    const line = html.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#e0982a"/)!.slice(1).map(Number);
    for (const corner of [0, 2]) {
      const at = label(corner);
      const box = corner === 0 ? { x0: at.x - 6 * 10.5, x1: at.x, y0: at.y - 10, y1: at.y + 3 } : { x0: at.x, x1: at.x + 6 * 10.5, y0: at.y - 10, y1: at.y + 3 };
      for (let i = 0; i <= 100; i += 1) {
        const x = line[0] + ((line[2] - line[0]) * i) / 100;
        const y = line[1] + ((line[3] - line[1]) * i) / 100;
        expect(x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1).toBe(false);
      }
    }
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
    expect(html).toContain("查看排序总量构成图表数据表");
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
    expect(html).toContain('<th scope="row">OUT</th><td>1</td>');
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

  test("a log-axis end tick is anchored inside the plot instead of being cut at the SVG edge", () => {
    // "10,000,000" centred on the last tick (x = 642 of 660) ran about 12 units past the right edge.
    expect(xTickAnchor(642, "10,000,000", 660)).toBe("end");
    expect(xTickAnchor(350, "10,000,000", 660)).toBe("middle");
    expect(xTickAnchor(642, "6", 660)).toBe("middle");
    expect(xTickAnchor(10, "1,000", 660)).toBe("start");
    const html = renderToStaticMarkup(
      <QuadrantScatter rows={[{ country: "AAA", x: 120, y: 1 }, { country: "BBB", x: 8_400_000, y: 2 }]} xKey="x" yKey="y" xLabel="出口" yLabel="份额" xFormat="amount" xScale="log" />,
    );
    expect(html).toMatch(/text-anchor="end"[^>]*>10,000,000</);
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
