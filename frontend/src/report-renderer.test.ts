import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render as renderDom } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { closeBoldBeforeCjkPunctuation, parseReportChart, ReportMarkdown } from "./report-renderer";

describe("report tables", () => {
  test("isolates literal reflection text from following report headings, tables and charts", () => {
    const prose = "段落 `指标` | 原文\n\n~~~\n```\n</div><script>文本</script>\n## 学生粘贴的标题";
    const chart = JSON.stringify({ version: 1, type: "bar", items: [{ label: "CHN", value: 1 }] });
    const markdown = `\`\`\`\`gvcsim-reflection\n${prose}\n\`\`\`\`\n\n## 系统证据\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n\`\`\`gvcsim-chart\n${chart}\n\`\`\``;
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(createElement(ReportMarkdown, { markdown }));
    expect(element.querySelector(".report-student-prose")?.textContent).toBe(prose);
    expect([...element.querySelectorAll("h2")].map((e) => e.textContent)).toEqual(["系统证据"]);
    expect(element.querySelectorAll("table")).toHaveLength(1);
    expect(element.querySelectorAll("figure")).toHaveLength(1);
    expect(element.querySelector("pre, script")).toBeNull();
  });

  test("names each scroll region by its heading and document order, including repeated headings", () => {
    const table = "| 项目 | 结果 |\n|---|---|\n| 系数 | 0.01 |";
    const markdown = `${table}\n\n### 步骤 11 · **贸易**结果\n\n${table}\n\n${table}\n\n### 步骤 12 · 生产结果\n\n${table}`;
    const render = () => renderToStaticMarkup(createElement(ReportMarkdown, { markdown }));
    const element = document.createElement("div");
    element.innerHTML = render();
    const regions = [...element.querySelectorAll('[role="region"]')];
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual([
      "报告数据表 1",
      "报告数据表 2：步骤 11 · 贸易结果",
      "报告数据表 3：步骤 11 · 贸易结果",
      "报告数据表 4：步骤 12 · 生产结果",
    ]);
    // Before a measurement says a table is wider than the column, it is not an extra Tab stop.
    expect(regions.every((region) => region.getAttribute("tabindex") === "-1")).toBe(true);
    expect(render()).toBe(render()); // No render-time counters shared between reports/renders.
  });

  test("only a table that overflows sideways is a Tab stop named 可横向滚动", () => {

    const table = "| 项目 | 结果 |\n|---|---|\n| 系数 | 0.01 |";
    const markdown = `### 宽表\n\n${table}\n\n### 窄表\n\n${table}`;
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    // The first region holds a table wider than the column; the second fits.
    const wide = (element: HTMLElement) => element.classList.contains("table-wrap") && element.getAttribute("aria-label")?.startsWith("报告数据表 1");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return wide(this) ? 900 : 600; } });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 600; } });
    try {
      const { container } = renderDom(createElement(ReportMarkdown, { markdown }));
      const regions = [...container.querySelectorAll('[role="region"]')];
      expect(regions.map((region) => [region.getAttribute("aria-label"), region.getAttribute("tabindex")])).toEqual([
        ["报告数据表 1：宽表，可横向滚动", "0"],
        ["报告数据表 2：窄表", "-1"],
      ]);
    } finally {
      cleanup();
      if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll);
      if (client) Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
    }
  });

  test("print rules fit report tables to paper without changing screen tables", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toMatch(/\.report-md p:has\(\+ \.table-wrap\)\s*\{[^}]*break-after:\s*avoid/);
    expect(print).toMatch(/\.report-md \.table-wrap\s*\{[^}]*overflow:\s*visible/);
    expect(print).toMatch(/\.report-md \.data-table\s*\{[^}]*table-layout:\s*fixed/);
    expect(print).toMatch(/\.report-md \.data-table td\s*\{[^}]*white-space:\s*normal/);
    expect(print).toMatch(/\.report-md \.data-table td\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(print).toMatch(/\.report-md \.data-table tr\s*\{[^}]*break-inside:\s*avoid/);
    // A chart's caption and heading stay with it: the figure is unbreakable and its SVG a block (inline, the
    // chart's line box moved to the next page alone).
    expect(print).toMatch(/\.report-md \.report-figure\s*\{[^}]*break-inside:\s*avoid/);
    expect(print).toMatch(/\.report-md \.report-figure svg\s*\{[^}]*display:\s*block/);
  });
});

describe("parseReportChart", () => {
  test("accepts the versioned bar, line and event-study schemas", () => {
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "bar",
      title: "Top 5",
      items: [{ label: "CHN", value: 0.42 }],
    }))).toMatchObject({ type: "bar" });
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "line",
      title: "两国趋势",
      series: [
        { label: "CHN", points: [{ label: "2019", value: 10 }, { label: "2020", value: 12 }] },
        { label: "USA", points: [{ label: "2019", value: 8 }, { label: "2020", value: 7 }] },
      ],
    }))).toMatchObject({ type: "line" });
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "event-study",
      points: [{ label: "k=0", value: -0.1, ci_low: -0.15, ci_high: -0.05 }],
    }))).toMatchObject({ type: "event-study" });
    // 已持久化的课程升级前 v1 报告仍可查看；新报告由后端发送 t(G−1) CI。
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "event-study",
      points: [{ label: "k=0", value: -0.1, se: 0.02 }],
    }))).toMatchObject({ type: "event-study" });
  });

  test("rejects unknown versions, non-finite values and invalid uncertainty", () => {
    expect(parseReportChart('{"version":2,"type":"bar","items":[{"label":"A","value":1}]}')).toBeNull();
    expect(parseReportChart('{"version":1,"type":"bar","items":[{"label":"A","value":NaN}]}')).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "event-study",
      points: [{ label: "k=0", value: 1, se: -0.1 }],
    }))).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "event-study",
      points: [{ label: "k=0", value: 1, ci_low: 2, ci_high: 3 }],
    }))).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "event-study",
      points: [{ label: "k=0", value: 1, ci_low: 0.5 }],
    }))).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "event-study",
      points: [{ label: "k=0", value: 1, se: 0.1, ci_low: 0.5, ci_high: 1.5 }],
    }))).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "bar",
      items: [{ label: "A", value: 1 }],
      html: "<b>x</b>",
    }))).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "bar",
      items: [{ label: "A", value: 1, color: "red" }],
    }))).toBeNull();
    // One saved economy without a reference is still a valid single-series chart.
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "line",
      series: [{ label: "CHN", points: [{ label: "2020", value: 1 }] }],
    }))).not.toBeNull();
    expect(parseReportChart(JSON.stringify({ version: 1, type: "line", series: [] }))).toBeNull();
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "line",
      series: [
        { label: "CHN", points: [{ label: "2020", value: 1, html: "bad" }] },
        { label: "USA", points: [{ label: "2020", value: 2 }] },
      ],
    }))).toBeNull();
  });

  test("caps chart size", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ label: String(i), value: i }));
    expect(parseReportChart(JSON.stringify({ version: 1, type: "bar", items }))).toBeNull();
  });

  test("renders GFM and a validated chart without enabling raw HTML", () => {
    const chart = JSON.stringify({ version: 1, type: "bar", items: [{ label: "CHN", value: 1 }] });
    const html = renderToStaticMarkup(createElement(ReportMarkdown, {
      markdown: `| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n![追踪图](https://attacker.example/pixel)\n\n\`\`\`gvcsim-chart\n${chart}\n\`\`\``,
    }));
    expect(html).toContain("<table");
    expect(html).toContain('role="img"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain("language-gvcsim-chart");
  });

  test("axis text is large enough at the report's 0.75x scale and the y unit clears the widest tick", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "line",
      title: "步骤 9 · 加权总度历年趋势",
      y_label: "百万美元",
      series: [
        { label: "CHN 中国", points: [{ label: "2016", value: 1800000 }, { label: "2020", value: 2400000 }] },
        { label: "USA 美国", points: [{ label: "2016", value: 1500000 }, { label: "2020", value: 1900000 }] },
      ],
    });
    const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    const dom = new DOMParser().parseFromString(html, "text/html");
    const texts = [...dom.querySelectorAll("svg text")];
    // 720-unit charts are shown about 540px wide: 14 units renders at about 10.5px.
    expect(texts.every((node) => Number(node.getAttribute("font-size")) >= 14)).toBe(true);
    const unit = texts.find((node) => node.textContent === "百万美元")!;
    const unitRight = Number(unit.getAttribute("x")) + 14 / 2;
    // Right-aligned y ticks ("2,500,000"): their left edge (about 0.6 em per digit or comma) must clear the unit.
    const ticks = texts.filter((node) => node.getAttribute("text-anchor") === "end");
    expect(ticks.length).toBeGreaterThan(1);
    for (const tick of ticks) {
      const left = Number(tick.getAttribute("x")) - (tick.textContent ?? "").length * 14 * 0.6;
      expect(left).toBeGreaterThan(unitRight);
    }
  });

  test("renders a validated two-series line chart with a legend", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "line",
      title: "两国历年趋势",
      series: [
        { label: "CHN", points: [{ label: "2019", value: 1 }, { label: "2020", value: 2 }] },
        { label: "USA", points: [{ label: "2019", value: 2 }, { label: "2020", value: 1 }] },
      ],
    });
    const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    expect(html).toContain("两国历年趋势");
    expect(html).toContain("CHN");
    expect(html).toContain("USA");
    expect(html.match(/<polyline/g)).toHaveLength(2);
  });

  test("draws a reference series (global median) as a grey dashed line after the countries", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "line",
      title: "历年趋势（含全球中位数）",
      series: [
        { label: "CHN 中国", points: [{ label: "2019", value: 11.9 }, { label: "2020", value: 11.7 }] },
        { label: "USA 美国", points: [{ label: "2019", value: 5.8 }, { label: "2020", value: 5.5 }] },
        { label: "全球中位数（76 个经济体）", reference: true, points: [{ label: "2019", value: 17.6 }, { label: "2020", value: 17.3 }] },
      ],
    });
    expect(parseReportChart(chart)).toMatchObject({ type: "line" });
    expect(parseReportChart(chart.replace("\"reference\":true", "\"reference\":\"yes\""))).toBeNull();
    const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    expect(html).toContain("全球中位数（76 个经济体）");
    expect(html.match(/stroke-dasharray="6 4"/g)).toHaveLength(1);
    // Countries keep the first two palette colours even though the reference series comes last.
    expect(html).toContain('stroke="#216cc0"');
    expect(html).toContain('stroke="#1baf7a"');
  });

  test("colours grouped bars by country with a legend and one label per industry", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "bar",
      title: "行业排名",
      items: [
        { label: "G 批发零售", group: "CHN 中国", value: 4320 },
        { label: "G 批发零售", group: "USA 美国", value: 4493 },
        { label: "C20 化学品", group: "CHN 中国", value: 4150 },
        { label: "C20 化学品", group: "USA 美国", value: 3337 },
      ],
    });
    expect(parseReportChart(chart)).toMatchObject({ type: "bar" });
    expect(parseReportChart(JSON.stringify({ version: 1, type: "bar", items: [{ label: "A", value: 1, group: 3 }] }))).toBeNull();
    const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    // Legend once per country, industry label once per pair of bars.
    expect(html.match(/>CHN 中国</g)).toHaveLength(1);
    expect(html.match(/>G 批发零售</g)).toHaveLength(1);
    expect(new Set(html.match(/fill="#(216cc0|1baf7a)"/g))).toEqual(new Set(['fill="#216cc0"', 'fill="#1baf7a"']));
  });

  test("draws the global-median bars grey, so they never read as a third country", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "bar",
      items: [
        { label: "国内增加值出口", group: "CHN 中国", value: 76.8 },
        { label: "国内增加值出口", group: "USA 美国", value: 85.3 },
        { label: "国内增加值出口", group: "全球中位数（76 个经济体）", value: 73.2, reference: true },
      ],
    });
    expect(parseReportChart(chart)).toMatchObject({ type: "bar" });
    expect(parseReportChart(chart.replace('"reference":true', '"reference":1'))).toBeNull();
    const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    // Countries keep the first two colours; the median (bar and legend) is the reference grey.
    expect(new Set(html.match(/fill="#[0-9a-f]{6}" fill-opacity/g))).toEqual(new Set([
      'fill="#216cc0" fill-opacity', 'fill="#1baf7a" fill-opacity', 'fill="#8a8f9c" fill-opacity',
    ]));
    expect(html).not.toContain("#eda100");
  });

  test("accepts and renders the regression coefficient chart with its interval", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "coefficient",
      title: "步骤 11 · X 每增加 1 个百分点时 Y 的平均变化",
      x_label: "个百分点",
      items: [{ label: "外国增加值项占比", value: -0.5516, ci_low: -0.6073, ci_high: -0.4959 }],
    });
    expect(parseReportChart(chart)).toMatchObject({ type: "coefficient" });
    // The interval must contain the estimate; a lone endpoint is rejected.
    expect(parseReportChart(JSON.stringify({ version: 1, type: "coefficient", items: [{ label: "Y", value: 1, ci_low: 2, ci_high: 3 }] }))).toBeNull();
    expect(parseReportChart(JSON.stringify({ version: 1, type: "coefficient", items: [{ label: "Y", value: 1, ci_low: 0 }] }))).toBeNull();
    const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    expect(html).toContain("外国增加值项占比");
    expect(html).toContain("-0.55");
    expect(html).toContain("[-0.61, -0.50]");
    expect(html).toContain("横线 = 95% 区间（真实系数的合理取值范围）");
  });

  test("a weak estimate's label is signed and kept off the zero line", () => {
    const chart = JSON.stringify({
      version: 1,
      type: "coefficient",
      x_label: "个百分点",
      items: [{ label: "复杂 GVC 生产份额", value: 0.00752, ci_low: -0.0112, ci_high: 0.0262 }],
    });
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${chart}\n\`\`\`` }));
    const labels = [...element.querySelectorAll("[data-coef-label]")];
    expect(labels.map((label) => label.textContent).join(" ")).toMatch(/^\+0\.008\s+\[-0\.011, \+0\.026\]$/);
    const zero = [...element.querySelectorAll("line")].find((line) => line.getAttribute("stroke-width") === "1.8" && line.getAttribute("x1") === line.getAttribute("x2"))!;
    // A positive estimate's labels start right of the zero line.
    for (const label of labels) {
      expect(label.getAttribute("text-anchor")).toBe("start");
      expect(Number(label.getAttribute("x"))).toBeGreaterThan(Number(zero.getAttribute("x1")));
    }
  });
});

test("react-markdown's node prop never reaches the DOM", async () => {
  const { ReportMarkdown } = await import("./report-renderer");
  const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: "# 标题\n\n数据版本 `step10-tariff-teaching-v5`\n\n```\nplain\n```\n\n> 引用" }));
  expect(html).not.toContain("node=");
});

test("bold ending in Chinese punctuation renders even in reports generated before the server fix", () => {
  const old = "- **2020 年：现价与疫情期外推限制。**本节为份额，**已闭合**。 末尾**说明。**";
  expect(closeBoldBeforeCjkPunctuation(old)).toBe("- **2020 年：现价与疫情期外推限制**。本节为份额，**已闭合**。 末尾**说明。**");
  const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: old }));
  expect(html).not.toContain("**");
  expect(html).toContain("<strong>2020 年：现价与疫情期外推限制</strong>。本节");
  // Followed by punctuation the bold closes on its own: the bracket stays inside it.
  const heading = "> **指标部分（步骤 1–9）**：覆盖 2016–2020。\n\n> **关税回归部分（步骤 10–14）**：X = w × τ。";
  expect(closeBoldBeforeCjkPunctuation(heading)).toBe(heading);
  const rendered = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: heading }));
  expect(rendered).toContain("<strong>指标部分（步骤 1–9）</strong>：覆盖");
  expect(rendered).toContain("<strong>关税回归部分（步骤 10–14）</strong>：X");
});
