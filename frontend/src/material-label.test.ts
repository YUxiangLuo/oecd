import { expect, test } from "bun:test";
import { countriesPhrase, networkMaterialLabel, recordedShockMaterialLabel, recordedVizMaterialLabel, regressionMaterialLabel, shockMaterialLabel, vizMaterialLabel } from "./material-label";
import type { TeachingCountriesResponse } from "./types";

test("every step's material reads as one sentence of the same shape", () => {
  expect(countriesPhrase(["CHN"])).toBe("CHN 中国");
  expect(countriesPhrase(["CHN", "USA"])).toBe("CHN 中国 对 USA 美国");
  expect(countriesPhrase(["CHN", "USA", "DEU"])).toBe("CHN 中国、USA 美国 与 DEU 德国");
  expect(vizMaterialLabel({ view: "历年变化", metric: "外国增加值项占比", countries: ["CHN", "USA"], years: [2016, 2020, 2018], readings: 10 }))
    .toBe("历年变化 · 外国增加值项占比 · CHN 中国 对 USA 美国 · 国家整体 · 2016–2020（10 条读数）");
  expect(vizMaterialLabel({ view: "国家对比", metric: "复杂 GVC 生产份额", countries: ["CHN"], industry: "C26", years: [2020], readings: 1 }))
    .toBe("国家对比 · 复杂 GVC 生产份额 · CHN 中国 · C26 计算机电子光学 · 2020（1 条读数）");
  expect(networkMaterialLabel({ view: "ranking", metric: "介数", countries: ["CHN", "USA"], years: [2020], readings: 20 })).toBe("行业排名 · 介数 · 2020 年 · CHN 中国 对 USA 美国（20 条读数）");
  expect(networkMaterialLabel({ view: "trend", metric: "加权总度", countries: ["CHN"], industry: "C26", years: [2016, 2020], readings: 5 })).toBe("历年变化 · 加权总度 · C26 计算机电子光学 · CHN 中国 · 2016–2020（5 条读数）");
  expect(shockMaterialLabel({ first: "CAN", second: "AUS", industry: "C29", firstTaxed: true, secondTaxed: false })).toBe("例子：CAN 加拿大（被加税） 对 AUS 澳大利亚（未被加税） · C29 汽车及零部件");
  expect(shockMaterialLabel({ first: "CAN", industry: "C29", firstTaxed: true })).toBe("例子：CAN 加拿大（被加税） · C29 汽车及零部件");
  expect(regressionMaterialLabel({ depvar: "外国增加值项占比", reading: "-0.55 个百分点", interval: "-0.57 个百分点 至 -0.54 个百分点" })).toBe("默认模型：外国增加值项占比两年累计 -0.55 个百分点（95% 区间 -0.57 个百分点 至 -0.54 个百分点）");
  expect(regressionMaterialLabel({ depvar: "加权总度", reading: null })).toBe("默认模型：加权总度（已计算，无法可靠推断）");
});

test("industry ranking labels describe all selected countries' industries, independent of the hidden scope", () => {
  for (const industry of [undefined, "C26"]) {
    expect(vizMaterialLabel({ view: "行业排名", metric: "外国增加值项占比", countries: ["CHN", "USA"], industry, allIndustries: true, years: [2020], readings: 4 }))
      .toBe("行业排名 · 外国增加值项占比 · CHN 中国 对 USA 美国 · 所选国家各行业 · 2020（4 条读数）");
  }
});

test("saved ranking labels correct only the known scope field and never rewrite recorded data", () => {
  for (const oldScope of ["国家整体", "C26 计算机电子光学", "所选国家各行业"]) {
    const saved = {
      material_label: `行业排名 · 外国增加值项占比 · CHN 中国 对 USA 美国 · ${oldScope} · 2020（4 条读数）`,
      indicator_selection: { view: "industry", industry: oldScope === "国家整体" ? "" : "C26" },
      browse_selection: { view: "trend", industry: "C29" },
      observations: [{ industry: "C26", value: 0.1 }, { industry: "C29", value: 0.2 }],
    };
    const before = JSON.stringify(saved);
    expect(recordedVizMaterialLabel(saved)).toBe("行业排名 · 外国增加值项占比 · CHN 中国 对 USA 美国 · 所选国家各行业 · 2020（4 条读数）");
    expect(JSON.stringify(saved)).toBe(before);
  }
});

test("ordinary charts and unknown legacy label formats keep their original text", () => {
  for (const view of ["trend", "comparison"]) {
    for (const industry of [undefined, "C26"]) {
      const material_label = vizMaterialLabel({ view: view === "trend" ? "历年变化" : "国家对比", metric: "外国增加值项占比", countries: ["CHN", "USA"], industry, years: view === "trend" ? [2019, 2020] : [2020], readings: 4 });
      expect(recordedVizMaterialLabel({ material_label, indicator_selection: { view, industry }, browse_selection: { view: "industry" } })).toBe(material_label);
      expect(material_label).toContain(industry ? "C26 计算机电子光学" : "国家整体");
    }
  }
  for (const material_label of ["旧材料", "行业排名 · 指标 · 国家", "行业排名 · 指标 · 国家 · 国家整体 · 未知年月", "行业排名 · 指标 · 国家 · 自定义说明 · 2020（4 条读数）", "行业排名 · 指标 · 国家 · 国家整体 · 2020（4 条读数） · 附注"]) {
    expect(recordedVizMaterialLabel({ material_label, indicator_selection: { view: "industry" } })).toBe(material_label);
  }
  expect(recordedVizMaterialLabel(undefined)).toBeNull();
  expect(recordedVizMaterialLabel({ indicator_selection: { view: "industry" } })).toBeNull();
});

test("saved service labels use country policy, not their zero industry tariff, and do not mutate history", () => {
  const saved = {
    compared: ["CHN", "AUS"], teaching_industry: "D",
    material_label: "例子：CHN 中国（未被加税） 对 AUS 澳大利亚（未被加税） · D 电力燃气",
    teaching_observation: { country: "CHN", teaching_tariff_rate_tau: 0, teaching_tariff_exposure: 0 },
  };
  const before = JSON.stringify(saved);
  const overview = {
    countries: [{ country: "CHN", taxed: true }, { country: "AUS", taxed: false }],
    taxed_rule: { scope: "goods industries (ICIO sectors A-C)" },
  } as TeachingCountriesResponse;
  expect(recordedShockMaterialLabel(saved, overview)).toBe("例子：CHN 中国（被加税） 对 AUS 澳大利亚（未被加税） · D 电力燃气（非货物行业，不加税）");
  expect(recordedShockMaterialLabel(saved)).toBe("例子：CHN 中国 对 AUS 澳大利亚 · D 电力燃气");
  expect(recordedShockMaterialLabel({ ...saved, teaching_industry: "C29" }, overview)).not.toContain("非货物行业，不加税");
  expect(recordedShockMaterialLabel(saved, { ...overview, taxed_rule: undefined })).not.toContain("非货物行业，不加税");
  expect(recordedShockMaterialLabel({ ...saved, material_label: undefined }, overview)).toBeNull();
  expect(recordedShockMaterialLabel(undefined, overview)).toBeNull();
  expect(JSON.stringify(saved)).toBe(before);
});
