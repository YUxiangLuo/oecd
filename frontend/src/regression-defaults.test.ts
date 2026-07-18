import { describe, expect, it } from "bun:test";
import { DEFAULT_REGRESSION_SETTINGS, SIGNATURE_SETTINGS, asRegressionSettingsMap } from "./regression";

describe("SIGNATURE_SETTINGS", () => {
  it("每步的招牌默认对应它要教的实验", () => {
    // 贸易:基准 DID(与全局默认一致,随后加控制)
    expect(SIGNATURE_SETTINGS.trade.method).toBe("did");
    expect(SIGNATURE_SETTINGS.trade.interaction).toBe(false);
    // 生产:开“冲击×基期GVC”异质性
    expect(SIGNATURE_SETTINGS.production.interaction).toBe(true);
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
