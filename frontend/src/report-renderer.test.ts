import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseReportChart, ReportMarkdown } from "./report-renderer";

describe("parseReportChart", () => {
  test("accepts the versioned bar and event-study schemas", () => {
    expect(parseReportChart(JSON.stringify({
      version: 1,
      type: "bar",
      title: "Top 5",
      items: [{ label: "CHN", value: 0.42 }],
    }))).toMatchObject({ type: "bar" });
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
      points: [{ label: "k=0", value: 1, se: -1 }],
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
});
