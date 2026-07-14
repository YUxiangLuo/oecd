import { describe, expect, test } from "bun:test";
import { INDICATOR_CASES, POLICY_CASE } from "./cases";
import { COUNTRY_NAMES } from "./viz";

// 镜像 gvcsim/api.py 的 INDICATOR_SCHEMA 字段键:案例引用的指标必须是真实存在的 schema 字段,
// 否则 CaseStrip 会显示 "—" 或跳到一个查不到值的指标。此表变更时同步更新即可。
const SCHEMA_FIELDS = new Set([
  "gross_exports", "FVA_share", "DVAex_share", "3_VA_GVC_share", "3b_VA_GVC_C_share",
  "DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub", "EXDVA", "SVA",
  "1_VA_D", "2_VA_RT", "3_VA_GVC", "3a_VA_GVC_S", "3b_VA_GVC_C",
  "FGY", "1_FGY_D", "2_FGY_RT", "3_FGY_GVC", "3a_FGY_GVC_S", "3b_FGY_GVC_C",
  "PLv", "PLv_D", "PLv_RT", "PLv_GVC", "PLy", "PLy_D", "PLy_RT", "PLy_GVC",
  "Pos_TPL", "GVCPs",
  "degree", "indegree", "outdegree",
  "weighted degree", "weighted indegree", "weighted outdegree", "Eccentricity",
  "closnesscentrality", "harmonicclosnesscentrality", "betweenesscentrality", "eigencentrality",
]);

const allCases = Object.entries(INDICATOR_CASES).flatMap(([step, cs]) =>
  cs.map((c) => ({ ...c, step: Number(step) })),
);

describe("INDICATOR_CASES", () => {
  test("every case references a real economy code (COUNTRY_NAMES)", () => {
    const bad = allCases.filter((c) => !COUNTRY_NAMES[c.economy]).map((c) => `${c.economy}@${c.step}`);
    expect(bad).toEqual([]);
  });

  test("every case references a real indicator schema field", () => {
    const bad = allCases.filter((c) => !SCHEMA_FIELDS.has(c.metric)).map((c) => `${c.metric}@${c.step}`);
    expect(bad).toEqual([]);
  });

  test("cases only attach to indicator/viz steps 4–11", () => {
    const steps = Object.keys(INDICATOR_CASES).map(Number);
    expect(steps.every((n) => n >= 4 && n <= 11)).toBe(true);
  });

  test("each step with cases has 2–3 of them", () => {
    for (const cs of Object.values(INDICATOR_CASES)) {
      expect(cs.length).toBeGreaterThanOrEqual(2);
      expect(cs.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("POLICY_CASE", () => {
  test("uses the tariff shock type and threads steps 2 → 12 → 13–16", () => {
    expect(POLICY_CASE.shockType).toBe("关税冲击");
    expect(Object.keys(POLICY_CASE.framing).map(Number).sort((a, b) => a - b)).toEqual([2, 12, 13, 14, 15, 16]);
  });

  test("honesty note flags the shock data as mock", () => {
    expect(POLICY_CASE.honesty).toContain("拟真");
  });
});
