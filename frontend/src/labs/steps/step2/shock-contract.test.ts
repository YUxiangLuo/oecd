import { describe, expect, test } from "bun:test";
import type { ShockContract } from "../../../types";
import {
  exposureSourceTeaching,
  inspectShockContract,
  SHOCK_CONTRACT_TYPES,
  SHOCK_EXPOSURE_CONTRACT,
} from "./shock-contract";

const valid = (): ShockContract => ({
  version: 2,
  treated_threshold: 0.001,
  treated_operator: ">",
  types: structuredClone(SHOCK_CONTRACT_TYPES),
  tariff_exposure: {
    ...SHOCK_EXPOSURE_CONTRACT,
    allowed_sources: [...SHOCK_EXPOSURE_CONTRACT.allowed_sources],
    allowed_modes: [...SHOCK_EXPOSURE_CONTRACT.allowed_modes],
  },
});

describe("versioned shock contract", () => {
  test("accepts only the complete v2 exact field/source/mode set", () => {
    expect(inspectShockContract(valid(), 8).valid).toBe(true);
    expect(inspectShockContract(valid(), 7).valid).toBe(false);
    for (const mutation of [
      (contract: ShockContract) => { contract.version = 0; },
      (contract: ShockContract) => { contract.treated_threshold = 0.0009; },
      (contract: ShockContract) => { contract.types.sanctions.note_field = "note"; },
      (contract: ShockContract) => { contract.tariff_exposure.allowed_sources.pop(); },
      (contract: ShockContract) => { contract.tariff_exposure.allowed_modes.push("unknown"); },
    ]) {
      const contract = valid();
      mutation(contract);
      expect(inspectShockContract(contract, 8).valid).toBe(false);
    }
    expect(inspectShockContract(undefined, 8).valid).toBe(false);
  });

  test("never describes fallback or unknown provenance as official", () => {
    expect(exposureSourceTeaching("oecd_icio_bilateral_flow").official).toBe(true);
    const fallback = exposureSourceTeaching("stylized_teaching_fallback");
    expect(fallback.official).toBe(false);
    expect(fallback.disclosure).toContain("不是 OECD ICIO");
    const invalid = exposureSourceTeaching("mixed");
    expect(invalid.official).toBe(false);
    expect(invalid.valid).toBe(false);
    expect(invalid.label).toContain("停止解释");
  });
});
