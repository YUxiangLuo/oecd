import { expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TeachingCountriesResponse } from "../../types";
import { countryIndustryLines, countryIndustryNote, CountryExposureChart, countryTipLines, goodsBalanceText, ruleYiUsd, taxedRuleText, yiUsd } from "./country-exposure";
import { TAXED, TAXED_LATER } from "./palette";

const row = (country: string, mean: number, taxed = mean > 0, exposed = taxed ? 44 : 0, industries = 44) => ({
  country, taxed, mean_exposure: mean, max_exposure: mean * 2, industries, exposed_industries: exposed,
});
const RULE = { basis: "first-year goods trade surplus with the market (ICIO sectors A-C)", min_million_usd: 1000, year: 2016 };
/** Million USD: CAN a surplus of 248,900 (2,489 亿美元), AUT a deficit of 1,234 (12.3 亿美元); MEX has none sent. */
const SURPLUS: Record<string, number> = { CAN: 248900, CRI: 1500, COL: 4321, PER: 2000, LUX: 1000, AUT: -1234, CHN: 950 };

const countriesFixture: TeachingCountriesResponse = {
  version: "step10-tariff-teaching-v8", year: 2020, market: "USA", tariff_rate: 0.25, policy_year: 2018,
  taxed_countries: 5, untaxed_countries: 3, entities: 350,
  countries: [
    row("CAN", 0.143), row("CRI", 0.0782, true, 42, 43), row("COL", 0.0727), row("PER", 0.057), row("LUX", 0.0051, true, 40, 40),
    row("AUT", 0), row("CHN", 0, false, 0, 41), row("MEX", 0, false, 0, 43),
  ],
};

test("the industry note counts taxed industries and says when some have X = 0", () => {
  expect(countryIndustryNote(row("CAN", 0.143))).toBe("44/44 个行业被加税");
  expect(countryIndustryNote(row("CRI", 0.0782, true, 42, 43))).toBe("43/43 个行业被加税（1 个货物行业对美无出口：w = 0）");
  // Goods only (v8): a taxed country's services are counted but not taxed.
  expect(countryIndustryNote({ ...row("DEU", 0.08, true, 33, 44), goods_industries: 34 })).toBe("34/44 个行业被加税（10 个服务业不加税，1 个货物行业对美无出口：w = 0）");
  expect(countryIndustryLines({ ...row("DEU", 0.08, true, 33, 44), goods_industries: 34 })).toEqual([
    ["被加税行业", "34 个（样本内共 44 个）"], ["服务业", "10 个，不加税"], ["其中 X > 0", "33 个"], ["其余 1 个", "对美无出口：w = 0"],
  ]);
  expect(countryIndustryNote(row("MEX", 0, false, 0, 43))).toBe("0/43 个行业被加税");
});

test("taxed bars are sorted, orange and scaled; untaxed countries form one group at 0; the imposer is not drawn", () => {
  try {
    render(<CountryExposureChart data={countriesFixture} />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe(
      "5 个被加税国家的关税暴露 X（2020 年各货物行业平均，个百分点），从高到低：最高 CAN 加拿大 14.30，最低 LUX 卢森堡 0.51；另有 3 国未被加税，X = 0",
    );
    const bars = [...svg.querySelectorAll("g.country-exposure-bar")];
    expect(bars.map((bar) => bar.getAttribute("data-country"))).toEqual(["CAN", "CRI", "COL", "PER", "LUX"]);
    const widths = bars.map((bar) => Number(bar.querySelectorAll("rect")[1].getAttribute("width")));
    // Sorted from the highest; the bar lengths follow X on one shared scale.
    expect([...widths].sort((a, b) => b - a)).toEqual(widths);
    expect(widths[0] / widths[2]).toBeCloseTo(0.143 / 0.0727, 2);
    expect(bars.every((bar) => bar.querySelectorAll("rect")[1].getAttribute("fill") === TAXED)).toBe(true);
    // Values in percentage points beside each bar.
    expect(bars[0].textContent).toContain("14.30");
    expect(bars[4].textContent).toContain("0.51");
    // The untaxed group: a label and one code per country, no bars.
    const group = screen.getByRole("group", { name: "3 国未被加税，X = 0" });
    expect(group.textContent).toContain("3 国未被加税（X = 0）");
    expect([...group.querySelectorAll("[data-country]")].map((item) => item.getAttribute("data-country"))).toEqual(["AUT", "CHN", "MEX"]);
    // The legend counts both groups; the untaxed ones are listed under the chart.
    expect([...document.querySelectorAll(".country-exposure-legend span")].map((item) => item.textContent)).toEqual([
      "被加税（5 国，按 X 从高到低）", "未被加税（3 国，X = 0，列在图下）",
    ]);
    // The USA is the imposer: never a bar or a code (the policy line above the chart says so, not the chart).
    expect(document.querySelector('[data-country="USA"]')).toBeNull();
    expect(document.querySelector(".country-exposure-note")!.textContent).toBe("悬停或用方向键查看每个国家的 X。");
    // All countries are listed in the collapsed table.
    expect(document.querySelectorAll(".country-exposure-table tbody tr")).toHaveLength(8);
  } finally {
    cleanup();
  }
});

test("one column of taxed bars and no example marks: no A/B badges, highlight, example legend or selected chip", () => {
  try {
    render(<CountryExposureChart data={countriesFixture} />);
    const svg = screen.getByRole("img");
    const bars = [...svg.querySelectorAll("g.country-exposure-bar")];
    // Every row's hit target starts at the left edge and every bar at the same x: one column, one row a country.
    expect(bars.map((bar) => bar.querySelectorAll("rect")[0].getAttribute("x"))).toEqual(["0", "0", "0", "0", "0"]);
    expect(new Set(bars.map((bar) => bar.querySelectorAll("rect")[1].getAttribute("x"))).size).toBe(1);
    const tops = bars.map((bar) => Number(bar.querySelectorAll("rect")[0].getAttribute("y")));
    expect(new Set(tops).size).toBe(5);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    // One axis title, under the one column.
    expect([...svg.querySelectorAll("text")].filter((text) => text.textContent!.includes("个百分点"))).toHaveLength(1);
    // Nothing marks an example: the chart is about all countries.
    expect(document.querySelectorAll("[data-highlight]")).toHaveLength(0);
    expect(document.querySelector(".country-exposure-badge")).toBeNull();
    expect(document.querySelector(".country-exposure-legend-example")).toBeNull();
    expect(document.body.textContent).not.toContain("你跟踪的例子");
    expect(document.body.textContent).not.toContain("例子 A");
    const chips = [...document.querySelectorAll(".country-exposure-codes > span")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["AUT", "CHN", "MEX"]);
    expect(chips.every((chip) => !chip.classList.contains("selected"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("hover and keyboard focus show the country, X and the industry count; arrows move one stop", () => {
  try {
    render(<CountryExposureChart data={countriesFixture} />);
    const tip = () => document.querySelector(".hover-tip")!.textContent;
    const cri = document.querySelector('[data-country="CRI"]')!;
    fireEvent.mouseMove(cri, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("CRI 哥斯达黎加");
    expect(tip()).toContain("7.82 个百分点");
    expect(tip()).toContain("被加税行业43 个（样本内共 43 个）");
    expect(tip()).toContain("其中 X > 042 个");
    expect(tip()).toContain("其余 1 个对美无出口：w = 0");
    fireEvent.mouseLeave(cri);
    // One tab stop: the first bar; arrows walk through the bars, then into the untaxed codes.
    const stops = [...document.querySelectorAll("[data-country]")].filter((item) => item.getAttribute("tabindex") === "0");
    expect(stops.map((item) => item.getAttribute("data-country"))).toEqual(["CAN"]);
    const lux = document.querySelector('[data-country="LUX"]') as HTMLElement;
    act(() => lux.focus());
    fireEvent.focus(lux);
    fireEvent.keyDown(lux, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-country")).toBe("AUT");
    fireEvent.focus(document.activeElement!);
    expect(tip()).toContain("AUT 奥地利");
    expect(tip()).toContain("0 个百分点");
    expect(tip()).toContain("被加税行业0 个（样本内共 44 个）");
    expect(tip()).not.toContain("其中");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.getAttribute("data-country")).toBe("CAN");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "CAN 加拿大：2020 年各货物行业平均 X = 14.30 个百分点，44/44 个行业被加税；方向键切换国家",
    );
  } finally {
    cleanup();
  }
});

test("amounts in million USD read in 亿美元, and the goods balance names a surplus or a deficit", () => {
  // One rule for every reading: one decimal from 1 up, two significant digits below 1.
  expect(yiUsd(1000)).toBe("10.0 亿美元");
  expect(yiUsd(300)).toBe("3.0 亿美元");
  expect(yiUsd(290)).toBe("2.9 亿美元");
  expect(yiUsd(13)).toBe("0.13 亿美元");
  expect(yiUsd(248900)).toBe("2,489 亿美元");
  expect(yiUsd(1234)).toBe("12.3 亿美元");
  expect(yiUsd(45)).toBe("0.45 亿美元");
  expect(yiUsd(0)).toBe("0 亿美元");
  // The rule's threshold is a set round number.
  expect(ruleYiUsd(1000)).toBe("10 亿美元");
  expect(goodsBalanceText({ market_goods_surplus: 248900 }, RULE)).toBe("2016 年对美货物顺差 2,489 亿美元");
  expect(goodsBalanceText({ market_goods_surplus: -1234 }, RULE)).toBe("2016 年对美货物逆差 12.3 亿美元");
  // Missing from an older server: nothing to say.
  expect(goodsBalanceText({ market_goods_surplus: null }, RULE)).toBeUndefined();
  expect(goodsBalanceText({}, RULE)).toBeUndefined();
  // No rule year: the first year, in words.
  expect(goodsBalanceText({ market_goods_surplus: 1500 }, { min_million_usd: 1000 })).toBe("首年对美货物顺差 15.0 亿美元");
  expect(taxedRuleText(RULE)).toBe("2016 年对美货物贸易顺差 ≥ 10 亿美元");
  expect(taxedRuleText(RULE, "达到或超过 ")).toBe("2016 年对美货物贸易顺差达到或超过 10 亿美元");
  expect(taxedRuleText(undefined)).toBeUndefined();
  expect(taxedRuleText(null)).toBeUndefined();
});

test("with the taxed rule, every country's readout gives its goods balance with the US (the rule itself is stated above the chart)", () => {
  const data: TeachingCountriesResponse = {
    ...countriesFixture,
    taxed_rule: RULE,
    countries: countriesFixture.countries.map((item) => (item.country in SURPLUS ? { ...item, market_goods_surplus: SURPLUS[item.country] } : item)),
  };
  try {
    render(<CountryExposureChart data={data} />);
    // The rule line moved to the policy sentence on the page; the note says what the readout adds.
    expect(document.querySelector(".country-exposure-rule")).toBeNull();
    expect(document.querySelector(".country-exposure-note")!.textContent).toBe("悬停或用方向键查看每个国家的 X 与对美货物顺差。");
    const tip = () => document.querySelector(".hover-tip")!.textContent;
    // A taxed bar on hover.
    fireEvent.mouseMove(document.querySelector('[data-country="CAN"]')!, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("2016 年对美货物顺差2,489 亿美元");
    // An untaxed code on hover and on keyboard focus (a deficit), with the same text in its accessible name.
    const aut = document.querySelector('[data-country="AUT"]') as HTMLElement;
    fireEvent.mouseMove(aut, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("2016 年对美货物逆差12.3 亿美元");
    fireEvent.mouseLeave(aut);
    act(() => aut.focus());
    fireEvent.focus(aut);
    expect(tip()).toContain("2016 年对美货物逆差12.3 亿美元");
    expect(aut.getAttribute("aria-label")).toBe("AUT 奥地利：2020 年各货物行业平均 X = 0 个百分点，0/44 个行业被加税，2016 年对美货物逆差 12.3 亿美元；方向键切换国家");
    // An untaxed surplus below the threshold.
    expect(document.querySelector('[data-country="CHN"]')!.getAttribute("aria-label")).toContain("2016 年对美货物顺差 9.5 亿美元");
    // A country the server sent no balance for says nothing about it.
    expect(document.querySelector('[data-country="MEX"]')!.getAttribute("aria-label")).not.toContain("对美货物");
    // The collapsed table lists the balance too (negative = deficit).
    expect(document.querySelector(".country-exposure-table thead")!.textContent).toContain("2016 年对美货物顺差（负数为逆差）");
    const cells = [...document.querySelectorAll(".country-exposure-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(cells[0]).toEqual(["CAN 加拿大", "被加税", "14.30", "44/44", "2,489 亿美元"]);
    expect(cells.find((cells) => cells[0] === "AUT 奥地利")).toEqual(["AUT 奥地利", "未被加税", "0", "0/44", "-12.3 亿美元"]);
    expect(cells.find((cells) => cells[0] === "MEX 墨西哥")!.at(-1)).toBe("—");
  } finally {
    cleanup();
  }
});

test("without the taxed rule (an older server) the chart adds no rule line or balance", () => {
  try {
    render(<CountryExposureChart data={countriesFixture} />);
    expect(document.querySelector(".country-exposure-rule")).toBeNull();
    expect(document.querySelector(".country-exposure-note")!.textContent).toBe("悬停或用方向键查看每个国家的 X。");
    expect(document.body.textContent).not.toContain("对美货物");
    expect(document.querySelector('[data-country="CAN"]')!.getAttribute("aria-label")).not.toContain("对美货物");
  } finally {
    cleanup();
  }
});

test("44 taxed countries form one column of 44 rows, every value label inside the 600-unit width", () => {
  const many: TeachingCountriesResponse = {
    ...countriesFixture,
    countries: Array.from({ length: 44 }, (_, index) => row(["CRI", "SAU", "KAZ", "SVN"][index % 4] + index, 0.15 - index * 0.003)),
  };
  try {
    render(<CountryExposureChart data={many} />);
    const svg = screen.getByRole("img");
    const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(width).toBe(600);
    // One 15-unit row a country, plus the top padding and the axis.
    expect(height).toBe(6 + 44 * 15 + 34);
    const bars = [...svg.querySelectorAll("g.country-exposure-bar")];
    expect(bars).toHaveLength(44);
    expect(bars.every((bar) => bar.querySelectorAll("rect")[0].getAttribute("x") === "0")).toBe(true);
    const valueEnds = bars.map((bar) => {
      const texts = bar.querySelectorAll("text");
      const value = texts[texts.length - 1];
      return Number(value.getAttribute("x")) + value.textContent!.length * 6.6;
    });
    // The value labels never run past the right edge.
    expect(valueEnds.every((end) => end <= 600)).toBe(true);
  } finally {
    cleanup();
  }
});

test("the readout fits its 260 px box: the industry count is split into short lines, and long values wrap", async () => {
  // CHN: 41 industries taxed, 40 with X > 0. One line read "41/41 个行业被加税（40 个 X > 0，其余对美无出口：w = 0）", 334 px.
  const chn = { ...row("CHN", 0.0512, true, 40, 41), market_goods_surplus: 248900 };
  const lines = countryTipLines(chn, 2020, RULE);
  expect(lines.slice(2, 5)).toEqual([["被加税行业", "41 个（样本内共 41 个）"], ["其中 X > 0", "40 个"], ["其余 1 个", "对美无出口：w = 0"]]);
  // A rough width at 11.5 px: CJK and full-width characters ~11.5 px, the rest ~6.6 px, plus the key and the gap.
  const width = (text: string) => [...text].reduce((sum, char) => sum + (/[　-￿]/.test(char) ? 11.5 : 6.6), 0);
  for (const [label, value] of lines.slice(1)) expect(18 + width(label) + 6 + width(value)).toBeLessThanOrEqual(236);
  // Every country fully exposed keeps one line.
  expect(countryIndustryLines(row("CAN", 0.143))).toEqual([["被加税行业", "44 个（样本内共 44 个）"]]);
  expect(countryIndustryLines(row("MEX", 0, false, 0, 43))).toEqual([["被加税行业", "0 个（样本内共 43 个）"]]);
  // And whatever the text, a value in this readout wraps instead of overflowing the box.
  const css = await Bun.file(new URL("../../workbench.css", import.meta.url)).text();
  expect(css).toContain(".country-exposure .hover-tip > div > b { white-space: normal; }");
});

test("keyboard focus in the lower half puts the readout above the item, clear of the note and the table summary", async () => {
  const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 700, width: 700, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  try {
    const view = render(<CountryExposureChart data={{ ...countriesFixture, taxed_rule: RULE }} />);
    const wrap = view.container.querySelector(".country-exposure") as HTMLElement;
    wrap.getBoundingClientRect = () => box(100, 400);
    const aut = document.querySelector('[data-country="AUT"]') as HTMLElement;
    aut.getBoundingClientRect = () => box(380, 20);
    act(() => aut.focus());
    fireEvent.focus(aut);
    const tip = view.container.querySelector(".hover-tip") as HTMLElement;
    // Its top (relative to the chart) is above AUT's top (280) by the readout's estimated height (three lines).
    expect(Number.parseFloat(tip.style.top)).toBeLessThanOrEqual(280 - 16 - 19 * 3);
    // An item in the upper half keeps the readout under it.
    const can = document.querySelector('[data-country="CAN"]') as HTMLElement;
    can.getBoundingClientRect = () => box(120, 17);
    act(() => can.focus());
    fireEvent.focus(can);
    expect(Number.parseFloat(tip.style.top)).toBeGreaterThanOrEqual(37);
    const css = await Bun.file(new URL("../../workbench.css", import.meta.url)).text();
    expect(css).toContain(".country-exposure-table { margin-top: 10px; }");
  } finally {
    cleanup();
  }
});


test("teaching data v10: a taxed country's readout says its wave and when its tariff starts", () => {
  const row = {
    country: "CAN", taxed: true, mean_exposure: 0.2, max_exposure: 0.4, industries: 44, goods_industries: 34,
    exposed_industries: 34, market_goods_surplus: 47400, wave: 1, start_year: 2018,
  };
  expect(countryTipLines(row, 2020)).toContainEqual(["加税", "第一批，2018 年起"]);
  expect(countryTipLines({ ...row, taxed: false, wave: 0, start_year: null }, 2020).some(([label]) => label === "加税")).toBe(false);
});

test("teaching data v10: the two waves have their own colour and legend entry, and each bar's label names its wave", () => {
  const waveOf: Record<string, [number, number]> = { CAN: [1, 2018], CRI: [2, 2019], COL: [2, 2019], PER: [2, 2019], LUX: [1, 2018] };
  const data = {
    ...countriesFixture,
    countries: countriesFixture.countries.map((item) => ({
      ...item, wave: waveOf[item.country]?.[0] ?? 0, start_year: waveOf[item.country]?.[1] ?? null,
    })),
  };
  try {
    render(<CountryExposureChart data={data} />);
    const bars = [...document.querySelectorAll("g.country-exposure-bar")];
    const fill = (country: string) => bars.find((bar) => bar.getAttribute("data-country") === country)!.querySelectorAll("rect")[1].getAttribute("fill");
    expect(fill("CAN")).toBe(TAXED);
    expect(fill("CRI")).toBe(TAXED_LATER);
    expect([...document.querySelectorAll(".country-exposure-legend span")].map((item) => item.textContent)).toEqual([
      "第一批被加税（2 国，2018 年起）", "第二批被加税（3 国，2019 年起）", "未被加税（3 国，X = 0，列在图下）",
    ]);
    expect(bars.find((bar) => bar.getAttribute("data-country") === "CRI")!.getAttribute("aria-label")).toStartWith("CRI 哥斯达黎加：第二批，2019 年起加税，2020 年各货物行业平均 X");
    // The folded 75 国读数表 says the wave too.
    const cells = [...document.querySelectorAll("table tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent));
    expect(cells.find((cells) => cells[0] === "CRI 哥斯达黎加")?.[1]).toBe("被加税（第二批，2019 年起）");
    expect(cells.find((cells) => cells[0] === "AUT 奥地利")?.[1]).toBe("未被加税");
  } finally {
    cleanup();
  }
});
