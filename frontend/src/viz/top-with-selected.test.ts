import { describe, expect, test } from "bun:test";
import { topWithSelected, type Row } from "./shared";

const countries = (rows: readonly Row[]) => rows.map((row) => String(row.country));

describe("topWithSelected", () => {
  test("appends selected entities outside Top N exactly once", () => {
    const rows: Row[] = [
      { country: "A", score: 9 },
      { country: "B", score: 8 },
      { country: "C", score: 7 },
      { country: "C", score: 6 },
      { country: "D", score: null },
    ];
    expect(countries(topWithSelected(rows, "score", 2, ["C", "C", "D"]))).toEqual(["A", "B", "C"]);
  });

  test("excludes null and nonfinite metrics instead of ranking them as zero", () => {
    const rows: Row[] = [
      { country: "ZERO", score: 0 },
      { country: "NULL", score: null },
      { country: "NAN", score: Number.NaN },
      { country: "INF", score: Number.POSITIVE_INFINITY },
      { country: "NEG", score: -2 },
    ];
    expect(countries(topWithSelected(rows, "score", 10, ["NULL", "NEG"]))).toEqual(["ZERO", "NEG"]);
  });

  test("uses entity keys as deterministic tie breakers and deduplicates by the supplied key", () => {
    const rows: Row[] = [
      { country: "Z", industry: "same", score: 5 },
      { country: "B", industry: "other", score: 5 },
      { country: "A", industry: "same", score: 6 },
      { country: "C", industry: "last", score: 5 },
    ];
    const result = topWithSelected(rows, "score", 3, [], (row) => String(row.industry));
    expect(result.map((row) => `${row.country}:${row.industry}`)).toEqual([
      "A:same",
      "C:last",
      "B:other",
    ]);
  });
});
