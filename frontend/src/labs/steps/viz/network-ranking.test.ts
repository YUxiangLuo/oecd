import { expect, test } from "bun:test";
import { networkRanking } from "./network-ranking";

test("ranks A before limiting, aligns B by industry, and keeps zero separate from missing", () => {
  const rows = [
    { country: "CHN", industry: "C", year: 2020, degree: 0 },
    { country: "CHN", industry: "B", year: 2020, degree: 30 },
    { country: "CHN", industry: "A", year: 2020, degree: 70 },
    { country: "CHN", industry: "D", year: 2020, degree: null },
    { country: "CHN", industry: "Z", year: 2019, degree: 900 },
    { country: "USA", industry: "B", year: 2020, degree: 100 },
    { country: "USA", industry: "A", year: 2020, degree: 1 },
  ];
  expect(networkRanking(rows, 2020, ["CHN", "USA"], "degree", 2)).toEqual([
    { industry: "A", values: [70, 1] }, { industry: "B", values: [30, 100] },
  ]);
  expect(networkRanking(rows, 2020, ["CHN", "USA"], "degree", 200).at(-1)).toEqual({ industry: "C", values: [0, null] });
  expect(networkRanking(rows, 2020, ["USA", "CHN"], "degree", 1)).toEqual([{ industry: "B", values: [100, 30] }]);
  expect(rows[0].industry).toBe("C");
});
