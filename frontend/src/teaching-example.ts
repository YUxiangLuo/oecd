import type { Meta } from "./types";

/** What step 10 saves about the example the student follows through steps 11–14. */
export interface TeachingExampleSelection {
  compared?: string[];
  teaching_industry?: string;
}

/**
 * The example pair followed from step 10 into steps 11–14. Defaults to Canada vs Mexico in motor
 * vehicles: both export heavily to the US, but only Canada is in the simulated tariff group, so the
 * pair shows that X comes from the tariff, not from export dependence alone.
 */
export function teachingExample(meta: Pick<Meta, "countries" | "sectors">, saved?: TeachingExampleSelection) {
  const countries = meta.countries.filter((code) => code !== "ROW");
  const carried = saved?.compared?.filter((code) => countries.includes(code)) ?? [];
  const first = carried[0] ?? (countries.includes("CAN") ? "CAN" : countries[0] ?? "");
  const second = carried.find((code) => code !== first)
    ?? (["MEX", "KOR"].find((code) => code !== first && countries.includes(code))
      ?? countries.find((code) => code !== first) ?? "");
  const industry = saved?.teaching_industry && meta.sectors.includes(saved.teaching_industry)
    ? saved.teaching_industry
    : meta.sectors.includes("C29") ? "C29" : meta.sectors[0] ?? "";
  return { countries, first, second, industry };
}
