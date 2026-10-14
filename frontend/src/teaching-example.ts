import type { Meta } from "./types";

/**
 * The country that imposes the simulated tariff. Its w ("share of exports to the US") is 0 by definition, so its
 * X is 0 only by definition; by design it is not in the regression sample (it is neither taxed nor a control).
 */
export const TARIFF_IMPOSER = "USA";

/** What step 10 saves about the example the student follows through steps 11–14. */
export interface TeachingExampleSelection {
  compared?: string[];
  teaching_industry?: string;
  /** True once the student picked the example on step 10 themselves; false for the default saved because the page was shown. */
  teaching_example_chosen?: boolean;
}

/**
 * The example followed from step 10 into steps 11–14: a country and an optional comparison country.
 * Defaults to Canada vs Costa Rica in motor vehicles: both sell most of those exports to the US, but only Canada
 * has a goods surplus with the US and is taxed (v7 rule), so the pair shows that X comes from the tariff, not from
 * export dependence alone. Australia is the untaxed comparison (well known, 19% of its C29 exports go to the US); South Africa, Costa Rica and Peru are the fallbacks. A saved selection with one country stays a single example (second is "").
 * The industry is the saved one, else always C29 (the autos reason above), never the industry last seen on step 9.
 */
export function teachingExample(
  meta: Pick<Meta, "countries" | "sectors">,
  saved?: TeachingExampleSelection,
) {
  const countries = meta.countries.filter((code) => code !== "ROW");
  const carried = saved?.compared?.filter((code) => countries.includes(code)) ?? [];
  const first = carried[0] ?? (countries.includes("CAN") ? "CAN" : countries[0] ?? "");
  const second = carried.length
    ? carried.find((code) => code !== first) ?? ""
    : ["AUS", "ZAF", "CRI", "PER"].find((code) => code !== first && countries.includes(code))
      ?? countries.find((code) => code !== first) ?? "";
  const industry = saved?.teaching_industry && meta.sectors.includes(saved.teaching_industry)
    ? saved.teaching_industry
    : meta.sectors.includes("C29") ? "C29" : meta.sectors[0] ?? "";
  return { countries, first, second, industry };
}
