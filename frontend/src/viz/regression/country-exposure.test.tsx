import { expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TeachingCountriesResponse } from "../../types";
import { countryIndustryLines, countryIndustryNote, CountryExposureChart, countryTipLines, goodsBalanceText, ruleYiUsd, splitColumns, taxedRuleText, yiUsd } from "./country-exposure";
import { TAXED } from "./palette";

const row = (country: string, mean: number, taxed = mean > 0, exposed = taxed ? 44 : 0, industries = 44) => ({
  country, taxed, mean_exposure: mean, max_exposure: mean * 2, industries, exposed_industries: exposed,
});
const RULE = { basis: "first-year goods trade surplus with the market (ICIO sectors A-C)", min_million_usd: 1000, year: 2016 };
/** Million USD: CAN a surplus of 248,900 (2,489 亿美元), AUT a deficit of 1,234 (12.3 亿美元); MEX has none sent. */
const SURPLUS: Record<string, number> = { CAN: 248900, CRI: 1500, COL: 4321, PER: 2000, LUX: 1000, AUT: -1234, CHN: 950 };

const countriesFixture: TeachingCountriesResponse = {
  version: "step10-tariff-teaching-v7", year: 2020, market: "USA", tariff_rate: 0.25, policy_year: 2018,
  taxed_countries: 5, untaxed_countries: 3, entities: 350,
  countries: [
    row("CAN", 0.143), row("CRI", 0.0782, true, 42, 43), row("COL", 0.0727), row("PER", 0.057), row("LUX", 0.0051, true, 40, 40),
    row("AUT", 0), row("CHN", 0, false, 0, 41), row("MEX", 0, false, 0, 43),
  ],
};

test("the industry note counts taxed industries and says when some have X = 0", () => {
  expect(countryIndustryNote(row("CAN", 0.143))).toBe("44/44 个行业被加税");
  expect(countryIndustryNote(row("CRI", 0.0782, true, 42, 43))).toBe("43/43 个行业被加税（42 个 X > 0，其余对美无出口：w = 0）");
  expect(countryIndustryNote(row("MEX", 0, false, 0, 43))).toBe("0/43 个行业被加税");
});

test("taxed countries split into two columns, the longer one first", () => {
  expect(splitColumns([1, 2, 3, 4, 5])).toEqual([[1, 2, 3], [4, 5]]);
  expect(splitColumns(Array.from({ length: 44 }, (_, i) => i)).map((column) => column.length)).toEqual([22, 22]);
});

test("taxed bars are sorted, orange and scaled; untaxed countries form one group at 0; the imposer is not drawn", () => {
  try {
    render(<CountryExposureChart data={countriesFixture} highlight={["CAN", "MEX"]} />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe(
      "5 个被加税国家的关税暴露 X（2020 年各行业平均，个百分点），从高到低：最高 CAN 加拿大 14.30，最低 LUX 卢森堡 0.51；另有 3 国未被加税，X = 0",
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
    // The USA is the imposer: named in a note, never a bar or a code.
    expect(document.querySelector('[data-country="USA"]')).toBeNull();
    expect(document.querySelector(".country-exposure-note")!.textContent).toContain("USA 美国 是加征关税的一方，不在样本中");
    // The example countries are marked A and B, a taxed bar and an untaxed code alike.
    expect(document.querySelector('[data-highlight="A"]')!.getAttribute("data-country")).toBe("CAN");
    expect(document.querySelector('[data-highlight="B"]')!.getAttribute("data-country")).toBe("MEX");
    expect(document.querySelectorAll("[data-highlight]")).toHaveLength(2);
    // All countries are listed in the collapsed table.
    expect(document.querySelectorAll(".country-exposure-table tbody tr")).toHaveLength(8);
  } finally {
    cleanup();
  }
});

test("hover and keyboard focus show the country, X and the industry count; arrows move one stop", () => {
  try {
    render(<CountryExposureChart data={countriesFixture} highlight={["CAN"]} />);
    const tip = () => document.querySelector(".hover-tip")!.textContent;
    const cri = document.querySelector('[data-country="CRI"]')!;
    fireEvent.mouseMove(cri, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("CRI 哥斯达黎加");
    expect(tip()).toContain("7.82 个百分点");
    expect(tip()).toContain("行业43/43 个被加税");
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
    expect(tip()).toContain("行业0/44 个被加税");
    expect(tip()).not.toContain("其中");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.getAttribute("data-country")).toBe("CAN");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "CAN 加拿大（例子 A）：2020 年各行业平均 X = 14.30 个百分点，44/44 个行业被加税；方向键切换国家",
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
  expect(yiUsd(248900)).toBe("2,489.0 亿美元");
  expect(yiUsd(1234)).toBe("12.3 亿美元");
  expect(yiUsd(45)).toBe("0.45 亿美元");
  expect(yiUsd(0)).toBe("0 亿美元");
  // The rule's threshold is a set round number.
  expect(ruleYiUsd(1000)).toBe("10 亿美元");
  expect(goodsBalanceText({ market_goods_surplus: 248900 }, RULE)).toBe("2016 年对美货物顺差 2,489.0 亿美元");
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

test("with the taxed rule, the chart states it and every country's readout gives its goods balance with the US", () => {
  const data: TeachingCountriesResponse = {
    ...countriesFixture,
    taxed_rule: RULE,
    countries: countriesFixture.countries.map((item) => (item.country in SURPLUS ? { ...item, market_goods_surplus: SURPLUS[item.country] } : item)),
  };
  try {
    render(<CountryExposureChart data={data} highlight={["CAN"]} />);
    expect(document.querySelector(".country-exposure-rule")!.textContent).toBe("被加税的规则来自 ICIO 数据：2016 年对美货物贸易顺差达到或超过 10 亿美元。");
    const tip = () => document.querySelector(".hover-tip")!.textContent;
    // A taxed bar on hover.
    fireEvent.mouseMove(document.querySelector('[data-country="CAN"]')!, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("2016 年对美货物顺差2,489.0 亿美元");
    // An untaxed code on hover and on keyboard focus (a deficit), with the same text in its accessible name.
    const aut = document.querySelector('[data-country="AUT"]') as HTMLElement;
    fireEvent.mouseMove(aut, { clientX: 10, clientY: 10 });
    expect(tip()).toContain("2016 年对美货物逆差12.3 亿美元");
    fireEvent.mouseLeave(aut);
    act(() => aut.focus());
    fireEvent.focus(aut);
    expect(tip()).toContain("2016 年对美货物逆差12.3 亿美元");
    expect(aut.getAttribute("aria-label")).toBe("AUT 奥地利：2020 年各行业平均 X = 0 个百分点，0/44 个行业被加税，2016 年对美货物逆差 12.3 亿美元；方向键切换国家");
    // An untaxed surplus below the threshold.
    expect(document.querySelector('[data-country="CHN"]')!.getAttribute("aria-label")).toContain("2016 年对美货物顺差 9.5 亿美元");
    // A country the server sent no balance for says nothing about it.
    expect(document.querySelector('[data-country="MEX"]')!.getAttribute("aria-label")).not.toContain("对美货物");
    // The collapsed table lists the balance too (negative = deficit).
    expect(document.querySelector(".country-exposure-table thead")!.textContent).toContain("2016 年对美货物顺差（负数为逆差）");
    const cells = [...document.querySelectorAll(".country-exposure-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(cells[0]).toEqual(["CAN 加拿大", "被加税", "14.30", "44/44", "2,489.0 亿美元"]);
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
    expect(document.body.textContent).not.toContain("对美货物");
    expect(document.querySelector('[data-country="CAN"]')!.getAttribute("aria-label")).not.toContain("对美货物");
  } finally {
    cleanup();
  }
});

test("44 taxed countries keep every label inside its column at the 700-unit width", () => {
  const many: TeachingCountriesResponse = {
    ...countriesFixture,
    countries: Array.from({ length: 44 }, (_, index) => row(["CRI", "SAU", "KAZ", "SVN"][index % 4] + index, 0.15 - index * 0.003)),
  };
  try {
    render(<CountryExposureChart data={many} />);
    const svg = screen.getByRole("img");
    const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(width).toBe(700);
    // 22 rows a column, so 44 named bars fit in under 430 units of height.
    expect(height).toBeLessThan(430);
    const valueEnds = [...svg.querySelectorAll("g.country-exposure-bar")].map((bar) => {
      const texts = bar.querySelectorAll("text");
      const value = texts[texts.length - 1];
      return Number(value.getAttribute("x")) + value.textContent!.length * 6.6;
    });
    // The value labels never run into the next column or past the right edge.
    expect(valueEnds.slice(0, 22).every((end) => end < 336)).toBe(true);
    expect(valueEnds.slice(22).every((end) => end <= 700)).toBe(true);
  } finally {
    cleanup();
  }
});

test("the readout fits its 260 px box: the industry count is split into short lines, and long values wrap", async () => {
  // CHN: 41 industries taxed, 40 with X > 0. One line read "41/41 个行业被加税（40 个 X > 0，其余对美无出口：w = 0）", 334 px.
  const chn = { ...row("CHN", 0.0512, true, 40, 41), market_goods_surplus: 248900 };
  const lines = countryTipLines(chn, 2020, RULE);
  expect(lines.slice(2, 5)).toEqual([["行业", "41/41 个被加税"], ["其中 X > 0", "40 个"], ["其余 1 个", "对美无出口：w = 0"]]);
  // A rough width at 11.5 px: CJK and full-width characters ~11.5 px, the rest ~6.6 px, plus the key and the gap.
  const width = (text: string) => [...text].reduce((sum, char) => sum + (/[　-￿]/.test(char) ? 11.5 : 6.6), 0);
  for (const [label, value] of lines.slice(1)) expect(18 + width(label) + 6 + width(value)).toBeLessThanOrEqual(236);
  // Every country fully exposed keeps one line.
  expect(countryIndustryLines(row("CAN", 0.143))).toEqual([["行业", "44/44 个被加税"]]);
  expect(countryIndustryLines(row("MEX", 0, false, 0, 43))).toEqual([["行业", "0/43 个被加税"]]);
  // And whatever the text, a value in this readout wraps instead of overflowing the box.
  const css = await Bun.file(new URL("../../workbench.css", import.meta.url)).text();
  expect(css).toContain(".country-exposure .hover-tip > div > b { white-space: normal; }");
});

test("marking an untaxed chip A or B does not change its width, so the rows never re-wrap", async () => {
  const css = await Bun.file(new URL("../../workbench.css", import.meta.url)).text();
  const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  // The badge sits over the chip's corner instead of taking room inside it.
  expect(rule(".country-exposure-codes > span > .country-exposure-badge")).toContain("position: absolute");
  expect(rule(".country-exposure-codes > span")).toContain("position: relative");
  // The selected chip is not bold (bold digits are wider).
  expect(rule(".country-exposure-codes > span.selected")).not.toContain("font-weight");
  try {
    render(<CountryExposureChart data={countriesFixture} highlight={["CAN", "MEX"]} />);
    const mex = document.querySelector('[data-country="MEX"]')!;
    expect(mex.className).toBe("selected");
    expect(mex.querySelector(".country-exposure-badge")!.textContent).toBe("B");
  } finally {
    cleanup();
  }
});
