import { describe, expect, it } from "bun:test";
import {
  DEFAULT_REGRESSION_SETTINGS,
  SIGNATURE_SETTINGS,
  asRegressionSettingsMap,
  normalizeRegressionSettings,
} from "./regression";

describe("SIGNATURE_SETTINGS", () => {
  it("四步共用关税 × DID 基准", () => {
    for (const settings of Object.values(SIGNATURE_SETTINGS)) {
      expect(settings.method).toBe("did");
      expect(settings.interaction).toBe(false);
      expect(settings.shockType).toBe("tariff");
      expect(settings.weightMode).toBe("fixed_pretreatment");
    }
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

describe("normalizeRegressionSettings", () => {
  it("does not let a hidden contemporaneous weight revive after returning to tariffs", () => {
    const restored = normalizeRegressionSettings({
      ...DEFAULT_REGRESSION_SETTINGS,
      shockType: "sanctions",
      weightMode: "contemporaneous",
    });
    const afterAnotherEdit = normalizeRegressionSettings({ ...restored, method: "event_study" });
    const backToTariff = normalizeRegressionSettings({ ...afterAnotherEdit, shockType: "tariff" });

    expect(restored.weightMode).toBe("fixed_pretreatment");
    expect(backToTariff.weightMode).toBe("fixed_pretreatment");
  });

  it("keeps contemporaneous weights available for tariff robustness checks", () => {
    const tariff = { ...DEFAULT_REGRESSION_SETTINGS, weightMode: "contemporaneous" };
    expect(normalizeRegressionSettings(tariff)).toBe(tariff);
  });
});
