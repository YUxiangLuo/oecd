import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { cleanup, render as renderDom } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { closeBoldBeforeCjkPunctuation, parseReportChart, REPORT_CHART_MAX_WIDTH, ReportMarkdown } from "./report-renderer";
import { layoutDivergingBars, MIN_WIDTH } from "./viz/regression/diverging-bars";
import { NEGATIVE, POSITIVE, UNCERTAIN, ZERO_LINE } from "./viz/regression/palette";

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

  test("a reference is a link named by its title; printed, its address follows", async () => {
    const html = renderToStaticMarkup(createElement(ReportMarkdown, {
      markdown: "## 方法参考文献\n\n1. Yamano et al. (2023), [*Development of the OECD Inter-Country Input-Output Database 2023*](https://doi.org/10.1787/5a5d0665-en)",
    }));
    const link = new DOMParser().parseFromString(html, "text/html").querySelector("a")!;
    expect(link.textContent).toBe("Development of the OECD Inter-Country Input-Output Database 2023");
    expect(link.getAttribute("href")).toBe("https://doi.org/10.1787/5a5d0665-en");
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
    expect(css.slice(css.indexOf("@media print"))).toMatch(/\.report-md a\[href\^="http"\]::after\s*\{[^}]*content:\s*"（" attr\(href\) "）"/);
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

// The report's step 11–14 and summary charts as gvcsim/report_regression_chart.py writes them for the course release
// (FVA saved in step 11, the weak Y saved in step 12, GVC 位置指数 in step 13, 加权总度 in step 14).
const REGRESSION_CHARTS = {
  trade: {"version":1,"type":"diverging-bar","title":"步骤 11 · 贸易流的 2 个 Y：X 每高 1 个百分点，Y 平均相差多少","x_label":"X 每高 1 个百分点，Y 平均相差（个百分点）","items":[{"label":"外国增加值项占比","value":-0.5493,"text":"-0.55","ci_low":-0.5711,"ci_high":-0.5274,"saved":true},{"label":"国内增加值出口占比","value":0.5561,"text":"+0.56","ci_low":0.5419,"ci_high":0.5702}]},
  production: {"version":1,"type":"diverging-bar","title":"步骤 12 · 生产的 7 个 Y：X 每高 1 个百分点，Y 平均相差多少","x_label":"X 每高 1 个百分点，Y 平均相差（个百分点）","items":[{"label":"复杂 GVC 生产份额","value":-0.3756,"text":"-0.38","ci_low":-0.3885,"ci_high":-0.3627},{"label":"前向 GVC 生产总份额","value":-0.6801,"text":"-0.68","ci_low":-0.6963,"ci_high":-0.6639},{"label":"后向 GVC 生产总份额","value":-0.4475,"text":"-0.45","ci_low":-0.4688,"ci_high":-0.4262},{"label":"简单 GVC 生产份额","value":-0.3045,"text":"-0.30","ci_low":-0.3181,"ci_high":-0.291},{"label":"传统贸易生产份额","value":-0.295,"text":"-0.30","ci_low":-0.306,"ci_high":-0.2841},{"label":"纯国内生产份额","value":0.9752,"text":"+0.98","ci_low":0.9553,"ci_high":0.995},{"label":"后向复杂 GVC 生产份额","value":0.007501,"text":"+0.008","ci_low":-0.01117,"ci_high":0.02617,"saved":true}]},
  length: {"version":1,"type":"diverging-bar","title":"步骤 13 · 长度的 3 个 Y：X 每高 1 个百分点，Y 平均相差多少","x_label":"X 每高 1 个百分点，Y 平均相差（个标准差）","items":[{"label":"前向 GVC 段长度","sub":"长度单位","value":-0.03118,"text":"-0.018（-0.031 个标准差）","ci_low":-0.03292,"ci_high":-0.02944},{"label":"后向 GVC 段长度","sub":"长度单位","value":-0.02559,"text":"-0.015（-0.026 个标准差）","ci_low":-0.02695,"ci_high":-0.02423},{"label":"GVC 位置指数","sub":"位置指数单位","value":-0.004425,"text":"-0.0008（-0.004 个标准差）","ci_low":-0.006494,"ci_high":-0.002356,"saved":true}],"note":"条长都换算成标准差（标准差即 Y 在国家×行业之间的典型差距），这样单位或量级差异较大的 Y 也能并列比较；条旁先写原始单位的数值，括号里是标准差。"},
  network: {"version":1,"type":"diverging-bar","title":"步骤 14 · 网络的 5 个 Y：X 每高 1 个百分点，Y 平均相差多少","x_label":"X 每高 1 个百分点，Y 平均相差（个标准差）","items":[{"label":"加权总度","sub":"中心性原始单位","value":-0.04703,"text":"-40.11（-0.047 个标准差）","ci_low":-0.04819,"ci_high":-0.04586,"saved":true},{"label":"加权入度","sub":"中心性原始单位","value":-0.04594,"text":"-19.91（-0.046 个标准差）","ci_low":-0.04745,"ci_high":-0.04443},{"label":"加权出度","sub":"中心性原始单位","value":-0.04654,"text":"-20.20（-0.047 个标准差）","ci_low":-0.04831,"ci_high":-0.04476},{"label":"介数","sub":"中心性原始单位","value":-0.1003,"text":"-60.11（-0.100 个标准差）","ci_low":-0.1029,"ci_high":-0.09772},{"label":"接近中心性","sub":"中心性原始单位","value":-0.0419,"text":"-0.0049（-0.042 个标准差）","ci_low":-0.04298,"ci_high":-0.04082}],"note":"条长都换算成标准差（标准差即 Y 在国家×行业之间的典型差距），这样单位或量级差异较大的 Y 也能并列比较；条旁先写原始单位的数值，括号里是标准差。"},
  summary: {"version":1,"type":"diverging-bar","title":"四步保存的结果（都换算成标准差）","x_label":"X 每高 1 个百分点，Y 平均相差（个标准差）","items":[{"label":"外国增加值项占比","sub":"步骤 11 · 贸易流","value":-0.06192,"text":"-0.55 个百分点（-0.062 个标准差）","ci_low":-0.06438,"ci_high":-0.05945},{"label":"后向复杂 GVC 生产份额","sub":"步骤 12 · 生产","value":0.001296,"text":"+0.008 个百分点（+0.001 个标准差）","ci_low":-0.001929,"ci_high":0.004521},{"label":"GVC 位置指数","sub":"步骤 13 · 长度","value":-0.004425,"text":"-0.0008 个位置指数单位（-0.004 个标准差）","ci_low":-0.006494,"ci_high":-0.002356},{"label":"加权总度","sub":"步骤 14 · 网络","value":-0.04703,"text":"-40.11 个中心性原始单位（-0.047 个标准差）","ci_low":-0.04819,"ci_high":-0.04586}],"note":"标准差即 Y 在国家×行业之间的典型差距；条形旁先写各步原始单位的数值（和上表相同），括号里是个标准差。"},
} as const;

// The course release's step 15 summary items (gvcsim summary_chart on panel_teaching.csv), with step 12's default Y
// and with its weak Y saved.
const RELEASE_ITEM = {
  trade: { label: "外国增加值项占比", sub: "步骤 11 · 贸易流", value: -0.0624, text: "-0.55 个百分点（-0.062 个标准差）", ci_low: -0.06453, ci_high: -0.06028 },
  production: { label: "复杂 GVC 生产份额", sub: "步骤 12 · 生产", value: -0.08088, text: "-0.39 个百分点（-0.081 个标准差）", ci_low: -0.08415, ci_high: -0.07761 },
  weak: { label: "后向复杂 GVC 生产份额", sub: "步骤 12 · 生产", value: 0.0009651, text: "+0.006 个百分点（+0.001 个标准差）", ci_low: -0.001361, ci_high: 0.003292 },
  length: { label: "前向 GVC 段长度", sub: "步骤 13 · 长度", value: -0.03156, text: "-0.0184 个长度单位（-0.032 个标准差）", ci_low: -0.03292, ci_high: -0.0302 },
  network: { label: "加权总度", sub: "步骤 14 · 网络", value: -0.0489, text: "-40.80 个中心性原始单位（-0.049 个标准差）", ci_low: -0.04983, ci_high: -0.04796 },
};
const RELEASE_SUMMARY_ITEMS = {
  default: [RELEASE_ITEM.trade, RELEASE_ITEM.production, RELEASE_ITEM.length, RELEASE_ITEM.network],
  weak: [RELEASE_ITEM.trade, RELEASE_ITEM.weak, RELEASE_ITEM.length, RELEASE_ITEM.network],
};

/** Same width estimate as the renderer: CJK about one em, Latin about 0.6 em. */
const estimatedWidth = (text: string, size: number) => [...text].reduce((width, char) => width + (/[⺀-￿]/.test(char) ? size : size * 0.6), 0);
/** A text's box; a stacked end label (tspans) is as wide as its longest line and as tall as all of them. */
function textBox(node: Element) {
  const x = Number(node.getAttribute("x"));
  const size = Number(node.getAttribute("font-size"));
  const spans = [...node.querySelectorAll(":scope > tspan[data-line]")];
  const lines = spans.length ? spans.map((span) => span.textContent ?? "") : [node.textContent ?? ""];
  // End labels set their value in bold.
  const bold = node.getAttribute("font-weight") === "700" || node.hasAttribute("data-bar-label");
  const width = Math.max(...lines.map((line) => estimatedWidth(line, size))) * (bold ? 1.06 : 1);
  const anchor = node.getAttribute("text-anchor") ?? "start";
  const left = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
  const y = Number(node.getAttribute("y"));
  const below = spans.reduce((sum, span) => sum + Number(span.getAttribute("dy") ?? 0), 0);
  return { left, right: left + width, top: y - size, bottom: y + below + 3 };
}

describe("regression bar charts (steps 11–14 and the summary)", () => {
  const renderChart = (chart: unknown) => {
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(createElement(ReportMarkdown, { markdown: `\`\`\`gvcsim-chart\n${JSON.stringify(chart)}\n\`\`\`` }));
    return element;
  };

  test("accepts only the strict diverging-bar schema", () => {
    const valid = REGRESSION_CHARTS.trade;
    expect(parseReportChart(JSON.stringify(valid))).toMatchObject({ type: "diverging-bar" });
    const withItem = (patch: Record<string, unknown>) => JSON.stringify({ ...valid, items: [{ ...valid.items[0], ...patch }] });
    expect(parseReportChart(withItem({ colour: "red" }))).toBeNull(); // unknown item key
    expect(parseReportChart(withItem({ text: "" }))).toBeNull();
    expect(parseReportChart(withItem({ saved: "yes" }))).toBeNull();
    expect(parseReportChart(withItem({ ci_low: -0.5 }))).toBeNull(); // the interval must contain the estimate
    expect(parseReportChart(withItem({ ci_high: undefined }))).toBeNull(); // a lone endpoint
    expect(parseReportChart(withItem({ value: Number.NaN }))).toBeNull();
    expect(parseReportChart(JSON.stringify({ ...valid, extra: 1 }))).toBeNull();
    expect(parseReportChart(JSON.stringify({ ...valid, note: "说".repeat(241) }))).toBeNull();
    expect(parseReportChart(JSON.stringify({ ...valid, items: valid.items.map((item) => ({ ...item, saved: true })) }))).toBeNull();
    expect(parseReportChart(JSON.stringify({ ...valid, items: Array.from({ length: 9 }, () => valid.items[1]) }))).toBeNull();
    // A suppressed interval is allowed (no whisker, grey bar).
    const { ci_low: _low, ci_high: _high, ...bare } = valid.items[0];
    expect(parseReportChart(JSON.stringify({ ...valid, items: [bare] }))).toMatchObject({ type: "diverging-bar" });
  });

  test("colours bars by direction, greys the uncertain one and marks the saved Y", () => {
    const element = renderChart(REGRESSION_CHARTS.production);
    const bars = [...element.querySelectorAll("svg path[data-bar]")];
    expect(bars).toHaveLength(7);
    expect(bars.map((bar) => bar.getAttribute("fill"))).toEqual([NEGATIVE, NEGATIVE, NEGATIVE, NEGATIVE, NEGATIVE, POSITIVE, UNCERTAIN]);
    // One capped whisker per bar.
    expect(element.querySelectorAll("[data-whisker]")).toHaveLength(7);
    expect(element.querySelectorAll("[data-whisker] line")).toHaveLength(21);
    const saved = element.querySelector('[data-diverging-row="saved"]')!;
    expect(saved.textContent).toContain("后向复杂 GVC 生产份额");
    expect(saved.querySelector("[data-saved-tag]")?.textContent).toBe("已保存");
    expect(saved.querySelector("path[data-bar]")?.getAttribute("stroke")).toBe(ZERO_LINE);
    expect(saved.querySelector("[data-bar-label]")?.textContent).toBe("+0.008 · 方向不确定");
    // The value is bold, "方向不确定" muted after it, as on the page.
    expect(saved.querySelector('[data-bar-label] tspan[font-weight="700"]')?.textContent).toBe("+0.008");
    expect(saved.querySelector('[data-bar-label] tspan[fill="#5f6677"]')?.textContent).toBe(" · 方向不确定");
    expect(element.querySelectorAll('[data-diverging-row="saved"]')).toHaveLength(1);
    // The legend names only the colours in use; all three are here.
    expect(element.querySelector("figure")?.textContent).toContain("X 越高，Y 越高X 越高，Y 越低方向不确定细线 = 95% 区间");
    const svg = element.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute("aria-label")).toContain("后向复杂 GVC 生产份额：+0.008，方向不确定，已保存");
    expect(svg.getAttribute("aria-label")).toContain("纯国内生产份额：+0.98");
    expect(element.querySelector("figcaption")?.textContent).toBe(REGRESSION_CHARTS.production.title);
  });

  test("a suppressed interval draws no whisker and reads 方向不确定", () => {
    const { ci_low: _low, ci_high: _high, ...bare } = REGRESSION_CHARTS.trade.items[0];
    const element = renderChart({ ...REGRESSION_CHARTS.trade, items: [bare] });
    expect(element.querySelectorAll("[data-whisker]")).toHaveLength(0);
    expect(element.querySelector("[data-bar-label]")?.getAttribute("data-bar-label")).toBe("-0.55 · 方向不确定");
    expect(element.querySelector("svg path[data-bar]")?.getAttribute("fill")).toBe(UNCERTAIN);
    // Only grey is in use, so the legend lists only 方向不确定.
    expect(element.querySelector("figure")?.textContent).not.toContain("X 越高");
  });

  test("a bar without an estimate or a standard deviation is drawn at 0 with the page's words", () => {
    const element = renderChart({
      ...REGRESSION_CHARTS.network,
      items: [{ label: "加权总度", sub: "中心性原始单位", value: 0, text: "没算出估计值", saved: true }, { label: "介数", value: 0, text: "-60.11（没有标准差）" }],
    });
    expect([...element.querySelectorAll("[data-bar-label]")].map((label) => label.getAttribute("data-bar-label"))).toEqual([
      "没算出估计值 · 方向不确定",
      "-60.11（没有标准差） · 方向不确定",
    ]);
    expect(element.querySelector("svg")?.outerHTML).not.toContain("NaN");
  });

  test.each(Object.entries(REGRESSION_CHARTS))("%s: every label fits the canvas and no two labels overlap", (_name, chart) => {
    const element = renderChart(chart);
    const svg = element.querySelector("svg")!;
    const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    const texts = [...svg.querySelectorAll("text")];
    expect(texts.every((node) => Number(node.getAttribute("font-size")) >= 14)).toBe(true);
    expect(svg.outerHTML).not.toContain("NaN");
    const boxes = texts.map((node) => ({ text: node.textContent, ...textBox(node) }));
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      expect(box.bottom).toBeLessThanOrEqual(height);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (overlaps) throw new Error(`labels overlap: "${a.text}" and "${b.text}"`);
      }
    }
    // Each end label sits beyond its bar and whisker, on the bar's side of the zero line.
    const zero = [...svg.querySelectorAll("line")].find((line) => line.getAttribute("stroke") === ZERO_LINE && line.getAttribute("x1") === line.getAttribute("x2") && !line.closest("[data-whisker]"))!;
    const zeroX = Number(zero.getAttribute("x1"));
    for (const row of svg.querySelectorAll("[data-diverging-row]")) {
      const label = textBox(row.querySelector("[data-bar-label]")!);
      const [barLeft, barRight] = row.querySelector("path[data-bar]")!.getAttribute("data-bar")!.split(" ").map(Number);
      const ends = [...row.querySelectorAll("[data-whisker] line")].flatMap((line) => [Number(line.getAttribute("x1")), Number(line.getAttribute("x2"))]);
      if (barLeft < zeroX - 0.5) expect(label.right).toBeLessThanOrEqual(Math.min(barLeft, ...ends));
      else expect(label.left).toBeGreaterThanOrEqual(Math.max(barRight, ...ends));
      // Row labels and the saved tag stay left of the plot.
      for (const name of row.querySelectorAll('text:not([data-bar-label])')) {
        expect(textBox(name).right).toBeLessThanOrEqual(Math.min(barLeft, zeroX, label.left, ...ends));
      }
    }
  });

  test("the summary labels each bar with its step and native value in standard deviations", () => {
    const element = renderChart(REGRESSION_CHARTS.summary);
    expect(element.querySelectorAll('[data-diverging-row="saved"]')).toHaveLength(0);
    const rows = [...element.querySelectorAll("[data-diverging-row]")];
    expect(rows.map((row) => row.querySelector("[data-bar-label]")?.getAttribute("data-bar-label"))).toEqual([
      "-0.55 个百分点（-0.062 个标准差）",
      "+0.008 个百分点（+0.001 个标准差） · 方向不确定",
      "-0.0008 个位置指数单位（-0.004 个标准差）",
      "-40.11 个中心性原始单位（-0.047 个标准差）",
    ]);
    expect(rows.map((row) => [...row.querySelectorAll('text[text-anchor="end"]:not([data-bar-label])')].at(-1)?.textContent)).toEqual([
      "步骤 11 · 贸易流", "步骤 12 · 生产", "步骤 13 · 长度", "步骤 14 · 网络",
    ]);
    expect(element.textContent).toContain("X 每高 1 个百分点，Y 平均相差（个标准差）");
    expect(element.textContent).toContain(REGRESSION_CHARTS.summary.note);
  });

  test.each([
    ["the default Ys", RELEASE_SUMMARY_ITEMS.default],
    ["the weak Y saved in step 12", RELEASE_SUMMARY_ITEMS.weak],
  ])("the summary with %s has the page's axis: same label stacking, extents within one tick step", (_name, items) => {
    const element = renderChart({ ...REGRESSION_CHARTS.summary, items });
    const svg = element.querySelector("svg")!;
    const reportTicks = [...svg.querySelectorAll("text")].filter((node) => /^-?[\d.]+$/.test(node.textContent ?? "")).map((node) => Number(node.textContent));
    const reportLines = Math.max(...[...svg.querySelectorAll("[data-bar-label]")].map((label) => Math.max(1, label.querySelectorAll("tspan[data-line]").length)));
    // The report draws 720 units with 15-unit text: the page's 12 px text on a 576 px drawing.
    const page = layoutDivergingBars(items.map((item, index) => ({
      key: String(index), label: item.label, sublabel: item.sub, value: item.value, low: item.ci_low, high: item.ci_high,
      uncertain: item.ci_low <= 0 && item.ci_high >= 0, valueLabel: item.text,
    })), 576);
    expect(page.width).toBe(576);
    expect(reportLines).toBe(page.rows.reduce((most, row) => Math.max(most, row.lines.length), 1));
    const pageTicks = page.ticks.map((tick) => tick.value);
    // The same axis range (only the tick density may differ), at every page width: the range comes from the data.
    expect([Math.min(...reportTicks), Math.max(...reportTicks)]).toEqual([Math.min(...pageTicks), Math.max(...pageTicks)]);
    for (const width of [MIN_WIDTH, 680, 760, 980]) {
      const ticks = layoutDivergingBars(items.map((item, index) => ({
        key: String(index), label: item.label, sublabel: item.sub, value: item.value, low: item.ci_low, high: item.ci_high,
        uncertain: item.ci_low <= 0 && item.ci_high >= 0, valueLabel: item.text,
      })), width).ticks.map((tick) => tick.value);
      expect([ticks[0], ticks.at(-1)]).toEqual([Math.min(...pageTicks), Math.max(...pageTicks)]);
    }
    // The end label stands clear of its whisker cap.
    for (const row of svg.querySelectorAll("[data-diverging-row]")) {
      const label = row.querySelector("[data-bar-label]")!;
      const caps = [...row.querySelectorAll("[data-whisker] line")].map((line) => Number(line.getAttribute("x1")));
      const x = Number(label.getAttribute("x"));
      const gap = label.getAttribute("text-anchor") === "end" ? Math.min(...caps) - x : x - Math.max(...caps);
      expect(gap).toBeGreaterThanOrEqual(12 - 1e-9);
    }
  });

  test("a long Y name wraps instead of being clipped", () => {
    const element = renderChart({ ...REGRESSION_CHARTS.trade, items: [{ ...REGRESSION_CHARTS.trade.items[0], label: "一个特别特别长的结果指标名称用来检查换行是否正常工作" }] });
    const names = [...element.querySelectorAll('[data-diverging-row] text[text-anchor="end"]:not([data-bar-label])')];
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(element.querySelector("[data-saved-tag]")).not.toBeNull();
    expect(names.every((name) => textBox(name).left >= 0)).toBe(true);
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


test("report charts stop growing at a width where their text is not larger than the report body", () => {
  // 720-unit drawings with 15-unit text: at 1280 px the column is wider than 720 px and the text grew past the
  // body's 13 px. Capped at 13/15 of 720, chart text renders at 13 px or less on every window.
  expect(REPORT_CHART_MAX_WIDTH).toBe(624);
  for (const chart of Object.values(REGRESSION_CHARTS)) {
    const markdown = `\`\`\`gvcsim-chart\n${JSON.stringify(chart)}\n\`\`\``;
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(createElement(ReportMarkdown, { markdown }));
    const svg = element.querySelector<SVGSVGElement>("figure svg");
    expect(svg?.getAttribute("style")).toContain("max-width:624px");
    expect(svg?.getAttribute("style")).toContain("width:100%");
  }
});
