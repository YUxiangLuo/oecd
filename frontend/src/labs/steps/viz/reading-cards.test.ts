import { describe, expect, test } from "bun:test";
import { comparisonCards, compositionCards, gapReading, industryCards, positioningCards, segmentCards } from "./reading-cards";
import { textNumber } from "./indicator-charts";

describe("段长度对照 cards name an undefined GVC length (round 12)", () => {
  const segments = [{ key: "gvc", label: "GVC 段", forward: "PLv_GVC", backward: "PLy_GVC" }];
  const reasonFor = (country: string, key: string) =>
    key === "PLy_GVC" || country === "LUX" ? `该行业没有这类 GVC 生产，${key} 无法计算（不是缺少数据）` : null;

  test("MLT B09: forward defined, backward undefined; LUX B09: neither", () => {
    const rows = [
      { country: "MLT", year: 2020, industry: "B09", PLv_GVC: 5.622, PLy_GVC: null },
      { country: "LUX", year: 2020, industry: "B09", PLv_GVC: null, PLy_GVC: null },
    ];
    const cards = segmentCards({ rows, countries: ["MLT", "LUX"], year: 2020, industry: "B09", segments, reasonFor });
    expect(cards[1].big).toBe("无法计算");
    expect(cards[1].small).toBe("该行业没有这类 GVC 生产，PLy_GVC 无法计算（不是缺少数据）");
    expect(cards[2].big).toBe("对比国家无法计算");
    expect(JSON.stringify(cards)).not.toContain("缺失");
  });
});

describe("cards name the industry when the scope is one industry (round 21)", () => {
  const composition = {
    total: "FGY",
    segments: [{ key: "d", name: "纯国内", color: "#000" }, { key: "c", name: "复杂 GVC", color: "#111" }],
    focus: "c", focusLabel: "后向复杂 GVC 生产份额", note: "",
  };
  const rows = [
    { country: "JPN", year: 2020, industry: "C26", FGY: 100, d: 94.2, c: 5.8 },
    { country: "USA", year: 2020, industry: "C26", FGY: 100, d: 98.2, c: 1.8 },
  ];

  test("step 7 JPN C26 · 后向: both own-country cards read country · industry", () => {
    const cards = compositionCards({ rows, countries: ["JPN", "USA"], composition, totalLabel: "最终品生产", year: 2020, industry: "C26" });
    expect(cards[0].eyebrow).toBe("JPN 日本 · C26 计算机电子光学 · 2020 · 最大分项");
    expect(cards[1].eyebrow).toBe("JPN 日本 · C26 计算机电子光学 · 后向复杂 GVC 生产份额");
    // A comparison card reads within the observed country's scope; the industry is not repeated there.
    expect(cards[2].eyebrow).toBe("与对比国家 USA 美国 · 后向复杂 GVC 生产份额");
  });

  test("country level keeps the plain country label", () => {
    const country = rows.map((row) => ({ ...row, industry: "" }));
    const cards = compositionCards({ rows: country, countries: ["JPN"], composition, totalLabel: "最终品生产", year: 2020, industry: "" });
    expect(cards[0].eyebrow).toBe("JPN 日本 · 2020 · 最大分项");
  });

  test("国家对比, 段长度对照 and 定位图 cards read the industry the same way", () => {
    const comparison = comparisonCards({
      rows: [{ country: "JPN", year: 2020, industry: "C26", m: 0.1 }], countries: ["JPN"], metric: "m", label: "份额", unit: "%", year: 2020, industry: "C26",
    });
    expect(comparison[0].eyebrow).toBe("JPN 日本 · C26 计算机电子光学 · 2020");
    const segments = segmentCards({
      rows: [{ country: "JPN", year: 2020, industry: "C26", PLv_GVC: 4.1, PLy_GVC: 4.0 }], countries: ["JPN"], year: 2020, industry: "C26",
      segments: [{ key: "gvc", label: "GVC 段", forward: "PLv_GVC", backward: "PLy_GVC" }],
    });
    expect(segments.map((card) => card.eyebrow)).toEqual([
      "JPN 日本 · C26 计算机电子光学 · 2020 · 最长的一段",
      "JPN 日本 · C26 计算机电子光学 · GVC 段 · 前向对后向",
    ]);
    const [position] = positioningCards({
      reference: [{ country: "JPN", x: 1, y: 1 }], countries: ["JPN"], xKey: "x", yKey: "y",
      xLabel: "横", yLabel: "纵", xFormat: "number", yFormat: "number", industry: "C26",
    });
    expect(position.eyebrow).toBe("JPN 日本 · C26 计算机电子光学");
  });
});

describe("amounts below 10 in reading texts keep three decimals (round 12)", () => {
  test("step 6 产品税减补贴 B05_06: a gap of 3.832 is not read as 4", () => {
    expect(gapReading(3.832, 0, "百万美元")).toBe("比它高 3.832 百万美元");
    expect(gapReading(0, 5.2, "百万美元")).toBe("比它低 5.200 百万美元");
    expect(gapReading(25, 12.6, "百万美元")).toBe("比它高 12 百万美元");
  });

  test("readings in cards: 3.4 reads 3.400, larger amounts stay whole, shares unchanged", () => {
    expect(textNumber(3.4, "百万美元")).toBe("3.400");
    expect(textNumber(-1.268, "百万美元")).toBe("-1.268");
    expect(textNumber(4279.4, "百万美元")).toBe("4,279");
    expect(textNumber(0, "百万美元")).toBe("0");
    expect(textNumber(0.1234, "%")).toBe("12.340%");
  });

  test("step 7 MLT H51: a negative total reads -1.268, as step 3 does", () => {
    const rows = [
      { country: "CHN", year: 2020, industry: "H51", SVA: 10, a: 6, b: 4 },
      { country: "MLT", year: 2020, industry: "H51", SVA: -1.2681, a: -0.6, b: -0.6681 },
    ];
    const cards = compositionCards({
      rows, countries: ["CHN", "MLT"], year: 2020, industry: "H51", totalLabel: "总增加值",
      composition: { total: "SVA", segments: [{ key: "a", name: "甲", color: "#000" }, { key: "b", name: "乙", color: "#111" }], note: "" },
    });
    expect(cards.at(-1)!.small).toContain("总量为负（-1.268 百万美元）");
  });

  test("定位图: a small x amount is not read as a whole number", () => {
    const [card] = positioningCards({
      reference: [{ country: "LUX", x: 3.21, y: 0.5 }], countries: ["LUX"], xKey: "x", yKey: "y",
      xLabel: "总出口", yLabel: "份额", xFormat: "amount", yFormat: "pct",
    });
    expect(String(card.big)).toContain("横轴 3.210");
  });
});

describe("gap readings distinguish exact equality from differences below display precision", () => {
  const units = [
    { unit: "%", scale: 100, suffix: " 个百分点" },
    { unit: "百万美元", scale: 1, suffix: " 百万美元" },
    { unit: "长度单位", scale: 1, suffix: " 长度单位" },
    { unit: "无量纲", scale: 1, suffix: "" },
  ];

  for (const { unit, scale, suffix } of units) {
    test(`${unit}: equal values retain exact equality`, () => {
      expect(gapReading(0.1, 0.1, unit)).toBe("与它持平");
      expect(gapReading(-0, 0, unit)).toBe("与它持平");
    });

    test(`${unit}: tiny positive and negative differences read as approximately equal`, () => {
      for (const gap of [0.0001, 0.000499999999]) {
        expect(gapReading(gap / scale, 0, unit)).toBe("与它基本持平");
        expect(gapReading(0, gap / scale, unit)).toBe("与它基本持平");
      }
    });

    test(`${unit}: differences at and above the rounding threshold retain direction and unit`, () => {
      for (const gap of [0.0005, 0.000500000001]) {
        expect(gapReading(gap / scale, 0, unit)).toBe(`比它高 0.001${suffix}`);
        expect(gapReading(0, gap / scale, unit)).toBe(`比它低 0.001${suffix}`);
      }
    });
  }

  test("2016 ESP and SWE foreign value-added shares read as approximately equal in both directions", () => {
    const rows = [
      { country: "ESP", year: 2016, industry: "", foreign_share: 0.16518858471062853 },
      { country: "SWE", year: 2016, industry: "", foreign_share: 0.16518435541563237 },
    ];
    for (const countries of [["ESP", "SWE"], ["SWE", "ESP"]]) {
      const cards = comparisonCards({
        rows, countries, metric: "foreign_share", label: "外国增加值项占比", unit: "%", year: 2016, industry: "",
      });
      expect(String(cards[1].big)).toEndWith("与它基本持平");
      expect(String(cards[1].big)).not.toContain("0.000");
    }
    expect(rows.map((row) => row.foreign_share)).toEqual([0.16518858471062853, 0.16518435541563237]);
  });
});

const cards = (points: [string, number, number][], countries = ["CHN"]) => positioningCards({
  reference: points.map(([country, x, y]) => ({ country, x, y })),
  countries, xKey: "x", yKey: "y", xLabel: "横轴指标", yLabel: "纵轴指标", xFormat: "number", yFormat: "number",
});

describe("定位图 reading cards", () => {
  test("a country on the median reads 等于中位数 once", () => {
    // Five distinct economies: CHN is the middle one on both axes.
    const [card] = cards([["USA", 1, 1], ["DEU", 2, 2], ["CHN", 3, 3], ["JPN", 4, 4], ["KOR", 5, 5]]);
    expect(card.big).toBe("横轴指标等于中位数，纵轴指标等于中位数");
  });

  test("economies that all share one reading are not compared with a median", () => {
    const economies = ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"];
    const [card] = cards(economies.map((country) => [country, 0, 0]));
    expect(card.small).toBe("图上 6 个经济体的读数相同，不比较中位数");
    expect(String(card.big)).not.toContain("中位数");
  });

  test("too few distinct readings among many economies are named as such", () => {
    const [card] = cards(["CHN", "USA", "DEU", "JPN", "KOR", "FRA"].map((country, i) => [country, i % 2, 0]));
    expect(card.small).toBe("图上 6 个经济体只有 2 个不同位置，不比较中位数");
  });
});

describe("行业排名 cards read a ratio as a bare number", () => {
  test("GVC 位置指数: no \"无量纲\" after the readings, as its gaps read; amounts keep 百万美元", () => {
    const groups = [{ key: "C26", label: "C26 计算机电子光学", values: [1.284, 0.913] }, { key: "C29", label: "C29 汽车及零部件", values: [0.958, 1.002] }];
    const ratio = industryCards({ groups, countries: ["CHN", "USA"], label: "GVC 位置指数", unit: "无量纲" });
    expect(ratio[0].small).toBe("1.284；按 CHN 中国 降序，只在显示的行业中比较");
    expect(ratio[1].small).toBe("CHN 中国 比它高 0.371（1.284 对 0.913）");
    expect(ratio.map((card) => card.small).join("")).not.toContain("无量纲");
    const amount = industryCards({ groups: [{ key: "C26", label: "C26 计算机电子光学", values: [33672, 4005] }], countries: ["CHN"], label: "加权总度", unit: "百万美元" });
    expect(amount[0].small).toBe("33,672 百万美元；按 CHN 中国 降序，只在显示的行业中比较");
  });
});
