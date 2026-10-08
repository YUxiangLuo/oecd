import { expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TeachingCountriesResponse } from "../../types";
import { countryIndustryNote, CountryExposureChart, splitColumns } from "./country-exposure";
import { TAXED } from "./palette";

const row = (country: string, mean: number, taxed = mean > 0, exposed = taxed ? 44 : 0, industries = 44) => ({
  country, taxed, mean_exposure: mean, max_exposure: mean * 2, industries, exposed_industries: exposed,
});

const countriesFixture: TeachingCountriesResponse = {
  version: "step10-tariff-teaching-v6", year: 2020, market: "USA", tariff_rate: 0.25, policy_year: 2018,
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
      "5 个加税国家的关税暴露 X（2020 年各行业平均，个百分点），从高到低：最高 CAN 加拿大 14.30，最低 LUX 卢森堡 0.51；另有 3 国未加税，X = 0",
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
    const group = screen.getByRole("group", { name: "3 国未加税，X = 0" });
    expect(group.textContent).toContain("3 国未加税（X = 0）");
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
    expect(tip()).toContain("43/43 个行业被加税");
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
    expect(tip()).toContain("0/44 个行业被加税");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.getAttribute("data-country")).toBe("CAN");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "CAN 加拿大（例子 A）：2020 年各行业平均 X = 14.30 个百分点，44/44 个行业被加税；方向键切换国家",
    );
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
