import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DistributionStrip, IndicatorTrendChart, layoutStripLabels } from "./indicator-charts";
import {
  changeReading,
  countryDistribution,
  indicatorMaterial,
  indicatorRows,
  materialComplete,
} from "./indicator-model";
import { LENGTH_TOPIC } from "./length";
import { PRODUCTION_TOPIC } from "./production";
import { TRADE_TOPIC } from "./trade";
import type { Row } from "./scaffold";

describe("indicator data contract", () => {
  test("derives each share from its declared numerator and denominator", () => {
    const [row] = indicatorRows(
      [
        {
          country: "CHN",
          FVA: 20,
          gross_exports: 80,
          "3b_VA_GVC_C": 12,
          "3_VA_GVC": 30,
          SVA: 60,
          FGY: 300,
        },
      ],
      PRODUCTION_TOPIC,
    );
    expect(row["3b_VA_GVC_C_share"]).toBe(0.2);
    expect(row["3_VA_GVC_share"]).toBe(0.5);
    // Production's forward shares must not accidentally use the unequal FGY total.
    expect(row["3b_VA_GVC_C_share"]).not.toBe(12 / 300);
    expect(
      indicatorRows(
        [{ country: "CHN", FVA: 20, gross_exports: 80 }],
        TRADE_TOPIC,
      )[0].FVA_share,
    ).toBe(0.25);
  });

  test("a non-positive denominator produces missing, while finite negative readings are valid", () => {
    expect(
      indicatorRows(
        [{ country: "CHN", FVA: -2, gross_exports: 10 }],
        TRADE_TOPIC,
      )[0].FVA_share,
    ).toBe(-0.2);
    for (const gross_exports of [0, -10]) {
      expect(
        indicatorRows(
          [{ country: "CHN", FVA: 2, gross_exports }],
          TRADE_TOPIC,
        )[0].FVA_share,
      ).toBeNull();
    }
  });

  test("material preserves country/industry/year identity and requires exactly paired countries", () => {
    const rows = [
      { country: "CHN", industry: "A", year: 2020, PLv_GVC: 2 },
      { country: "USA", industry: "A", year: 2020, PLv_GVC: 3 },
      { country: "CHN", industry: "A", year: 2021, PLv_GVC: -1 },
      { country: "USA", industry: "A", year: 2021, PLv_GVC: 4 },
    ];
    const material = indicatorMaterial(
      rows,
      ["CHN", "USA"],
      [2020, 2021],
      ["PLv_GVC"],
      LENGTH_TOPIC,
      "A",
      "explicit-indicator-trend",
      "release",
    );
    expect(material[0]).toMatchObject({
      entity: "CHN·A",
      country: "CHN",
      industry: "A",
      year: 2020,
      scope: "country-industry",
      value: 2,
    });
    expect(
      materialComplete(material, ["CHN", "USA"], ["PLv_GVC"], true),
    ).toBeTrue();
    expect(
      materialComplete(material.slice(1), ["CHN", "USA"], ["PLv_GVC"], true),
    ).toBeFalse();
    expect(materialComplete(material, ["CHN"], ["PLv_GVC"], true)).toBeFalse();
  });

  test("share changes are percentage-point differences", () => {
    expect(changeReading(0.12, 0.2, "%")).toBe("+8 个百分点");
    // Amounts read in whole millions; a dimensionless ratio carries no unit word.
    expect(changeReading(1_968_964.539, 2_496_175.368, "百万美元")).toBe("+527,211 百万美元");
    expect(changeReading(0.4, 0.75, "百万美元")).toBe("+0.35 百万美元");
    expect(changeReading(1.029, 1.023, "无量纲")).toBe("-0.006");
  });
});

describe("trend rendering", () => {
  test("does not connect across a missing year and retains negative points", () => {
    const html = renderToStaticMarkup(
      createElement(IndicatorTrendChart, {
        rows: [
          { country: "CHN", year: 2019, PLv_GVC: -1 },
          { country: "CHN", year: 2021, PLv_GVC: 3 },
        ],
        countries: ["CHN"],
        years: [2019, 2020, 2021],
        metric: "PLv_GVC",
        label: "前向",
        unit: "生产阶段（账户比值）",
      }),
    );
    expect(html).toContain("-1");
    expect(html).not.toContain("data-series=");
  });

  test("length position draws the GVCPs=1 baseline", () => {
    const html = renderToStaticMarkup(
      createElement(IndicatorTrendChart, {
        rows: [{ country: "CHN", year: 2020, GVCPs: 0.8 }],
        countries: ["CHN"],
        years: [2020],
        metric: "GVCPs",
        label: "位置",
        unit: "无量纲",
      }),
    );
    expect(html).toContain("位置基准 = 1");
  });

  test("names the two-country trend conclusion as a semantic group", () => {
    const html = renderToStaticMarkup(
      createElement(IndicatorTrendChart, {
        rows: [
          { country: "CHN", year: 2019, value: 1 },
          { country: "CHN", year: 2020, value: 2 },
          { country: "USA", year: 2019, value: 2 },
          { country: "USA", year: 2020, value: 3 },
        ],
        countries: ["CHN", "USA"],
        years: [2019, 2020],
        metric: "value",
        label: "示例指标",
        unit: "单位",
      }),
    );
    expect(html).toContain('class="comparison-summary" role="group" aria-label="两国趋势结论"');
  });
});

describe("gap readings", () => {
  test("a gap change that rounds to zero reads as unchanged, never as “差距扩大 0”", () => {
    const rows = [
      { country: "JPN", year: 2016, value: 0.9551 },
      { country: "JPN", year: 2020, value: 0.9524 },
      { country: "DEU", year: 2016, value: 0.9425 },
      { country: "DEU", year: 2020, value: 0.9394 },
    ];
    const html = renderToStaticMarkup(createElement(IndicatorTrendChart, {
      rows, countries: ["JPN", "DEU"], years: [2016, 2020], metric: "value", label: "入边分数", unit: "无量纲", mode: "context",
    }));
    expect(html).toContain("差距基本不变");
    expect(html).not.toContain("差距扩大 0");
  });
});

describe("global reference for steps 6–8", () => {
  test("uses every economy except ROW and industry rows, with pandas-style quantiles and tied ranks", () => {
    const rows = [
      ...[["A", 0.1], ["B", 0.2], ["C", 0.2], ["D", 0.4], ["E", 0.5]].map(([country, value]) => ({ country, year: 2020, FVA_share: value })),
      { country: "ROW", year: 2020, FVA_share: 0.9 },
      { country: "A", industry: "C26", year: 2020, FVA_share: 0.95 },
      { country: "F", year: 2020, FVA_share: null },
    ];
    const [entry] = countryDistribution(rows as Row[], "FVA_share", [2020]);
    expect(entry.n).toBe(5);
    expect(entry.median).toBeCloseTo(0.2);
    expect(entry.p25).toBeCloseTo(0.2);
    expect(entry.p75).toBeCloseTo(0.4);
    expect(entry.ranks).toEqual({ E: 1, D: 2, B: 3, C: 3, A: 5 });
    expect(countryDistribution(rows as Row[], "FVA_share", [2019])).toEqual([]);
  });

  test("the context trend draws the median and puts the comparison country last", () => {
    const rows = [2019, 2020].flatMap((year) => [["CHN", 0.12], ["USA", 0.06], ["DEU", 0.17], ["JPN", 0.1]].map(([country, value]) => ({ country, year, FVA_share: (value as number) + (year - 2019) / 100 })));
    const html = renderToStaticMarkup(createElement(IndicatorTrendChart, {
      rows, countries: ["CHN", "USA"], years: [2019, 2020], metric: "FVA_share", label: "外国增加值项占比", unit: "%",
      distribution: countryDistribution(rows, "FVA_share", [2019, 2020]), mode: "context",
    }));
    expect(html).toContain(`data-series="global-median"`);
    expect(html).toContain("全球中位数");
    expect(html).toContain("USA 美国（对比）");
    expect(html.indexOf("全部经济体中")).toBeLessThan(html.indexOf("与对比国家"));
  });

  test("the distribution strip stays short for skewed amounts and labels both countries with their ranks", () => {
    // 60 economies crowded near zero and one giant: without a lane cap this stacked 60 dots high.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ country: `C${i}`, year: 2020, SVA: 100 + i })),
      { country: "CHN", year: 2020, SVA: 15_000_000 },
      { country: "USA", year: 2020, SVA: 300 },
    ] as Row[];
    const [distribution] = countryDistribution(rows, "SVA", [2020]);
    const html = renderToStaticMarkup(createElement(DistributionStrip, {
      rows, metric: "SVA", unit: "百万美元", label: "总增加值", year: 2020, highlight: ["CHN", "USA"], distribution,
    }));
    const height = Number(/viewBox="0 0 800 ([0-9]+)"/.exec(html)?.[1]);
    expect(height).toBeLessThanOrEqual(70 + 8 * 9 + 60);
    expect(html).toContain("第 1 位");
    expect(html).toContain("USA 美国");
  });

  test("strip labels never put one country's leader line on the other country's label", () => {
    const text = "CHN 中国 11.73% · 第 54 位";
    // Close dots (USA 5.51% left of CHN 11.73%, as on the real FVA strip): one row, split at the dots.
    const [chn, usa] = layoutStripLabels([{ px: 210, text }, { px: 140, text }]);
    expect([chn.row, usa.row]).toEqual([0, 0]);
    const inside = (dot: number, label: { labelX: number; width: number }) => dot >= label.labelX && dot <= label.labelX + label.width;
    expect(inside(210, usa) || inside(140, chn)).toBeFalse();
    expect(chn.labelX).toBe(210);
    // Far apart: each label centred under its own dot.
    const [a, b] = layoutStripLabels([{ px: 200, text }, { px: 600, text }]);
    expect(a.labelX + a.width / 2).toBe(200);
    expect(b.labelX + b.width / 2).toBe(600);
    // Same reading near the right edge: two rows, and the lower leader does not cross the upper label.
    const [x, y] = layoutStripLabels([{ px: 780, text }, { px: 780, text }]);
    expect(x.row + y.row).toBe(1);
  });
});
