import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NetworkRanking } from "./network-ranking";

test("every compared country shows its own global rank, not only country A", () => {
  const html = renderToStaticMarkup(
    <NetworkRanking
      rows={[{ industry: "C26", values: [300, 120] }]}
      countries={["CHN", "USA"]}
      unit="百万美元"
      onIndustry={() => {}}
      reference={new Map([["C26", { median: 50, n: 76, ranks: { CHN: 1, USA: 9 }, ties: { CHN: 1, USA: 1 } }]])}
    />,
  );
  expect(html).toContain("全球第 1 位 / 76");
  expect(html).toContain("全球第 9 位 / 76");
});

test("an undefined path metric is named, and the caption covers it (round 12)", () => {
  const html = renderToStaticMarkup(
    <NetworkRanking
      rows={[{ industry: "C26", values: [0.4, null], undefinedAt: [false, true] }]}
      countries={["USA", "LUX"]}
      unit="无量纲"
      onIndustry={() => {}}
    />,
  );
  expect(html).toContain("无连接，无法定义");
  expect(html).toContain("缺少或无法定义的数据留空，不当作 0。");
});
