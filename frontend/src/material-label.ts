/** One-sentence descriptions of a step's report material, saved with the record as `material_label` (a view
 * key on the server) and shown again on step 15, so the student reads the same words on the step and on the
 * checklist. Each step builds its own sentence; the shapes below keep them alike. */
import { countryLabel, sectorLabel } from "./viz";
import type { TeachingCountriesResponse } from "./types";

/** "CHN 中国 对 USA 美国" / "CHN 中国、USA 美国 与 DEU 德国". */
export function countriesPhrase(codes: readonly string[]): string {
  const names = codes.map(countryLabel);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} 对 ${names[1]}`;
  return `${names.slice(0, -1).join("、")} 与 ${names.at(-1)}`;
}

/** Steps 6–8: "历年变化 · 外国增加值项占比 · CHN 中国 对 USA 美国 · 国家整体 · 2016–2020（10 条读数）". */
export function vizMaterialLabel(parts: { view: string; metric: string; countries: readonly string[]; industry?: string; allIndustries?: boolean; years: readonly number[]; readings: number }): string {
  const years = [...new Set(parts.years)].sort((a, b) => a - b);
  const span = years.length > 1 ? `${years[0]}–${years.at(-1)}` : String(years[0] ?? "");
  const scope = parts.allIndustries ? "所选国家各行业" : parts.industry ? sectorLabel(parts.industry) : "国家整体";
  return `${parts.view} · ${parts.metric} · ${countriesPhrase(parts.countries)} · ${scope} · ${span}（${parts.readings} 条读数）`;
}

/** Older industry-ranking labels used the hidden single-industry selection as their scope.
 * Correct only that field in the saved label's known format, using the recorded (not browsed) view.
 * This is presentation only: existing observations, report fingerprints and submitted material stay intact. */
export function recordedVizMaterialLabel(data: Record<string, unknown> | undefined): string | null {
  if (typeof data?.material_label !== "string") return null;
  const selection = data.indicator_selection;
  if (!selection || typeof selection !== "object" || !("view" in selection) || selection.view !== "industry") return data.material_label;
  const parts = data.material_label.split(" · ");
  if (parts.length !== 5 || parts[0] !== "行业排名" || !/^\d{4}(?:–\d{4})?（\d+ 条读数）$/.test(parts[4])) return data.material_label;
  const oldScope = "industry" in selection && typeof selection.industry === "string" && selection.industry
    ? sectorLabel(selection.industry) : "国家整体";
  if (!parts[1] || !parts[2] || ![oldScope, "所选国家各行业"].includes(parts[3])) return data.material_label;
  parts[3] = "所选国家各行业";
  return parts.join(" · ");
}

/** Step 9: "行业排名 · 介数 · 2020 年 · CHN 中国 对 USA 美国（前 10 个行业，20 条读数）". */
export function networkMaterialLabel(parts: { view: "trend" | "ranking"; metric: string; countries: readonly string[]; industry?: string; years: readonly number[]; readings: number }): string {
  const years = [...new Set(parts.years)].sort((a, b) => a - b);
  return parts.view === "trend"
    ? `历年变化 · ${parts.metric} · ${parts.industry ? sectorLabel(parts.industry) : ""} · ${countriesPhrase(parts.countries)} · ${years[0]}–${years.at(-1)}（${parts.readings} 条读数）`
    : `行业排名 · ${parts.metric} · ${years[0]} 年 · ${countriesPhrase(parts.countries)}（${parts.readings} 条读数）`;
}

/** Step 10: "例子：CAN 加拿大（被加税）对 AUS 澳大利亚（未被加税）· C29 汽车及零部件". */
export function shockMaterialLabel(parts: { first: string; second?: string; industry: string; firstTaxed?: boolean; secondTaxed?: boolean; serviceExempt?: boolean }): string {
  // A zero industry tariff cannot classify the country: services are exempt even in taxed countries.
  // While the country list is unavailable, leave the classification out instead of guessing.
  const tag = (taxed: boolean | undefined) => taxed == null ? "" : `（${taxed ? "被加税" : "未被加税"}）`;
  const second = parts.second ? ` 对 ${countryLabel(parts.second)}${tag(parts.secondTaxed)}` : "";
  return `例子：${countryLabel(parts.first)}${tag(parts.firstTaxed)}${second} · ${sectorLabel(parts.industry)}${parts.serviceExempt ? "（非货物行业，不加税）" : ""}`;
}

/** Rebuild the step 10 label for display from its recorded selection and authoritative country list.
 * Older saved labels inferred a country's status from its industry's tariff and mislabelled services.
 * Correct their presentation without changing recorded numbers, report fingerprints or submitted reports. */
export function recordedShockMaterialLabel(data: Record<string, unknown> | undefined, overview?: TeachingCountriesResponse): string | null {
  if (typeof data?.material_label !== "string") return null;
  const countries = Array.isArray(data.compared) ? data.compared.filter((code): code is string => typeof code === "string" && Boolean(code)) : [];
  if (!countries.length || typeof data.teaching_industry !== "string" || !data.teaching_industry) return null;
  return shockMaterialLabel({
    first: countries[0], second: countries[1], industry: data.teaching_industry,
    firstTaxed: overview?.countries.find((row) => row.country === countries[0])?.taxed,
    secondTaxed: overview?.countries.find((row) => row.country === countries[1])?.taxed,
    serviceExempt: Boolean(overview?.taxed_rule?.scope) && !/^[ABC]/.test(data.teaching_industry),
  });
}

/** Steps 11–14: "默认模型：外国增加值项占比两年累计 −0.55 个百分点（95% 区间 −0.57 至 −0.54）". */
export function regressionMaterialLabel(parts: { depvar: string; reading: string | null; interval?: string | null }): string {
  if (!parts.reading) return `默认模型：${parts.depvar}（已计算，无法可靠推断）`;
  return `默认模型：${parts.depvar}两年累计 ${parts.reading}${parts.interval ? `（95% 区间 ${parts.interval}）` : ""}`;
}
