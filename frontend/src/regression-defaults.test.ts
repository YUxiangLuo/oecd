import { describe, expect, it } from "bun:test";
import { DEFAULT_REGRESSION_SETTINGS, SIGNATURE_SETTINGS, asRegressionSettingsMap, marginalEffectEvidenceText } from "./regression";
import type { MarginalEffect, RegressionResponse } from "./types";

describe("SIGNATURE_SETTINGS", () => {
  it("每步的招牌默认对应它要教的实验", () => {
    // 贸易:基准 DID(与全局默认一致,随后加控制)
    expect(SIGNATURE_SETTINGS.trade.method).toBe("did");
    expect(SIGNATURE_SETTINGS.trade.interaction).toBe(false);
    expect(SIGNATURE_SETTINGS.trade.weightMode).toBe("fixed_pretreatment");
    // 生产:先跑无交互基准,再打开异质性作第二次运行
    expect(SIGNATURE_SETTINGS.production.interaction).toBe(false);
    // 长度:事件研究看动态路径
    expect(SIGNATURE_SETTINGS.length.method).toBe("event_study");
    // 网络:DID(随后跑安慰剂),且只允许国家–行业级
    expect(SIGNATURE_SETTINGS.network.method).toBe("did");
    expect(SIGNATURE_SETTINGS.network.granularity).toBe("country_industry");
  });

  it("四个 outcome 都有招牌默认", () => {
    expect(Object.keys(SIGNATURE_SETTINGS).sort()).toEqual(["length", "network", "production", "trade"]);
  });
});

describe("asRegressionSettingsMap", () => {
  it("按 outcome 分的 map 原样返回", () => {
    const map = { length: { ...DEFAULT_REGRESSION_SETTINGS, method: "did" } };
    expect(asRegressionSettingsMap(map)).toBe(map);
  });

  it("旧的单份扁平设定(含 method 顶层键)一律忽略,让各步按招牌默认 seed", () => {
    expect(asRegressionSettingsMap(DEFAULT_REGRESSION_SETTINGS)).toEqual({});
    expect(asRegressionSettingsMap({ method: "event_study", granularity: "country" })).toEqual({});
  });

  it("空值/非对象返回空 map", () => {
    expect(asRegressionSettingsMap(undefined)).toEqual({});
    expect(asRegressionSettingsMap(null)).toEqual({});
    expect(asRegressionSettingsMap("x")).toEqual({});
  });
});

describe("production marginal-effect evidence", () => {
  it("turns server-computed low/mean/high effects into concrete report-ready numbers", () => {
    const response = {
      design: { method: "did", interaction: true },
      result: {},
    } as RegressionResponse;
    const effects: MarginalEffect[] = [
      { policy_term: "treated×post", interaction_term: "treated×post×base_gvc", level: "low", label: "低（P25）", reference: "p25", baseline_gvc_centered: -0.1, effect: 0.02, se: 0.01, t: 2, p: 0.05, ci_low: 0.001, ci_high: 0.039 },
      { policy_term: "treated×post", interaction_term: "treated×post×base_gvc", level: "mean", label: "均值", reference: "mean", baseline_gvc_centered: 0, effect: 0.01, se: 0.01, t: 1, p: 0.3, ci_low: -0.01, ci_high: 0.03 },
      { policy_term: "treated×post", interaction_term: "treated×post×base_gvc", level: "high", label: "高（P75）", reference: "p75", baseline_gvc_centered: 0.1, effect: 0, se: 0.01, t: 0, p: 1, ci_low: -0.02, ci_high: 0.02 },
    ];
    const text = marginalEffectEvidenceText(response, effects);
    expect(text).toContain("低（P25）基期 GVC");
    expect(text).toContain("+2.00 个百分点");
    expect(text).toContain("高（P75）基期 GVC");
    expect(text).toContain("交互系数本身不是平均效应");
  });
});
