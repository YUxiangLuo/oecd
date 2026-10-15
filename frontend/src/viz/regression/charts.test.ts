import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupChangeChart, spreadLabels, type GroupLine } from "./charts";

const years = [2016, 2017, 2018, 2019, 2020];
const series = (end: number, from = 2) => years.map((year, index) => ({ year, change: index < from ? 0 : end }));
const markers = [{ year: 2018, label: "2018 年第一批加税" }, { year: 2019, label: "2019 年第二批加税" }];
const lines = (first: number, second: number, untaxed: number): GroupLine[] => [
  { key: "first", label: "第一批被加税", color: "#d6731f", points: series(first) },
  { key: "second", label: "第二批被加税", color: "#8f4f12", points: series(second, 3), dashed: true },
  { key: "untaxed", label: "未被加税", color: "#6b7487", points: series(untaxed) },
];
const labelY = (markup: string, text: string) => Number(new RegExp(`y="([\\d.]+)"[^>]*>${text}<`).exec(markup)?.[1]);

describe("group chart lines", () => {
  test("each group's name sits at its line end", () => {
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, markers, lines: lines(-0.04, -0.01, 0.004), scale: 100, unit: "个百分点", title: "t",
    }));
    const end = (color: string) => [...markup.matchAll(new RegExp(`<circle cx="[\\d.]+" cy="([\\d.]+)" r="3.5" fill="${color}"`, "g"))].map((m) => Number(m[1])).at(-1)!;
    expect(Math.abs(labelY(markup, "第一批被加税") - end("#d6731f"))).toBeLessThanOrEqual(9);
    expect(Math.abs(labelY(markup, "未被加税") - end("#6b7487"))).toBeLessThanOrEqual(9);
    // The second wave is dashed too, so the two waves never differ by colour alone; no estimate bracket is drawn.
    expect(markup).toMatch(/stroke="#8f4f12"[^>]*stroke-dasharray="6 3"/);
    expect(markup).not.toContain("data-estimate");
  });

  test("lines that end together keep their names apart", () => {
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, markers, lines: lines(0.0042, 0.0042, 0.0042), scale: 100, unit: "个百分点", title: "t",
    }));
    const ys = ["第一批被加税", "第二批被加税", "未被加税"].map((text) => labelY(markup, text)).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(16);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(16);
  });

  test("spreadLabels keeps order and pushes close labels apart inside the bounds", () => {
    const slots = spreadLabels([
      { key: "a", at: 100, size: 14 }, { key: "b", at: 101, size: 14 }, { key: "e", at: 100.5, size: 28 },
    ], 20, 216);
    expect(slots.a).toBeLessThan(slots.e);
    expect(slots.e).toBeLessThan(slots.b);
    expect(slots.e - slots.a).toBeGreaterThanOrEqual(23);
    expect(slots.b - slots.e).toBeGreaterThanOrEqual(23);
    const low = spreadLabels([{ key: "a", at: 215, size: 14 }, { key: "b", at: 216, size: 14 }], 20, 216);
    expect(low.b).toBeLessThanOrEqual(209);
    expect(low.b - low.a).toBeGreaterThanOrEqual(16);
  });
});

describe("group chart markers", () => {
  test("each tariff start is marked, the two labels stacked so they never overlap", () => {
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, markers, lines: lines(-0.04, -0.01, 0.004), scale: 100, unit: "个百分点", title: "t",
    }));
    const dom = new DOMParser().parseFromString(markup, "text/html");
    const labels = [...dom.querySelectorAll("[data-marker] text")];
    expect(labels.map((node) => node.textContent)).toEqual(["2018 年第一批加税", "2019 年第二批加税"]);
    expect(Number(labels[1].getAttribute("y")) - Number(labels[0].getAttribute("y"))).toBeGreaterThanOrEqual(12);
    // The baseline period ends before the first tariff.
    expect(markup).toContain("纵轴：相对 2016–2017 年平均水平的变化（个百分点）");
  });
});

describe("group chart readings", () => {
  test("long end names are shortened but retain their full title and table heading", () => {
    const label = "第一批被加税国家非常长的完整组名";
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, markers, lines: [{ ...lines(1, 0, 0)[0], label }], unit: "无量纲", title: "long",
    }));
    const dom = new DOMParser().parseFromString(markup, "text/html");
    const end = dom.querySelector('[data-line="first"] > text')!;
    expect(end.firstChild?.textContent).toEndWith("…");
    expect(end.querySelector("title")?.textContent).toBe(label);
    expect(dom.querySelector("thead")?.textContent).toContain(label);
  });

  test("tiny changes retain nonzero ticks and readings", () => {
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, markers, lines: lines(1e-12, -1e-12, 0), unit: "无量纲", title: "tiny",
    }));
    const dom = new DOMParser().parseFromString(markup, "text/html");
    expect([...dom.querySelectorAll("tbody td")].some((cell) => Number(cell.textContent) > 0)).toBe(true);
    expect([...dom.querySelectorAll("svg text")].some((cell) => Number(cell.textContent) > 0 && Number(cell.textContent) < 1)).toBe(true);
  });

  test("empty and single-year markerless charts have no invented baseline", () => {
    for (const sample of [[], [2020]]) {
      const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
        years: sample, markers: [], lines: [], unit: "无量纲", title: "empty",
      }));
      expect(markup).not.toContain("NaN");
      expect(markup).toContain("基期未指定");
    }
  });

  test("a small negative change that rounds to zero reads 0.0, never -0.0 (table and tooltips)", () => {
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years: [2016, 2017, 2018], markers: [{ year: 2018, label: "2018 年起加税" }], scale: 100, unit: "个百分点", title: "t",
      lines: [
        { key: "taxed", label: "被加税", color: "#d6731f", points: [2016, 2017, 2018].map((year, index) => ({ year, change: [-0.000004, 0.000003, -0.2][index] })) },
        { key: "untaxed", label: "未被加税", color: "#6b7487", points: [2016, 2017, 2018].map((year) => ({ year, change: 0 })) },
      ],
    }));
    expect(markup).not.toMatch(/>-0\.0+</);
    expect(markup).not.toMatch(/：-0\.0+ /);
    expect(markup).toContain("<th scope=\"row\">2016</th><td>0.0</td>");
    expect(markup).toContain("<td>-20.0</td>");
  });

  test("a folded table gives each year's value for every group, in the chart's unit", () => {
    const markup = renderToStaticMarkup(createElement(GroupChangeChart, {
      years, markers, lines: lines(-0.04, -0.01, 0.004), scale: 100, unit: "个百分点", title: "加税前后",
    }));
    const dom = new DOMParser().parseFromString(markup, "text/html");
    const details = dom.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("各组逐年读数");
    expect([...details.querySelectorAll("thead th")].map((cell) => cell.textContent))
      .toEqual(["年份", "第一批被加税（个百分点）", "第二批被加税（个百分点）", "未被加税（个百分点）"]);
    const rows = [...details.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
    // The same values as the dots' tooltips.
    expect(markup).toContain("<title>第一批被加税 2018 年：-4.00 个百分点</title>");
    expect(rows[2]).toEqual(["2018（第一批加税）", "-4.00", "0.00", "0.40"]);
    expect(rows[3]).toEqual(["2019（第二批加税）", "-4.00", "-1.00", "0.40"]);
  });
});
