import { describe, expect, test } from "bun:test";
import {
  buildDecompositionModel,
  decompositionDomainRows,
  decompositionRequestKey,
  directZeroTotalKind,
  explicitDemoCountry,
  finiteNumber,
  matchingDecompositionResponse,
  type DecompositionSpec,
} from "./decomposition-model";

const amount: DecompositionSpec = {
  total: "total",
  parts: [{ key: "a" }, { key: "b" }],
};
const forward: DecompositionSpec = {
  total: "PLv",
  weightTotal: "SVA",
  parts: [
    { key: "PLv_D", weightKey: "1_VA_D" },
    { key: "PLv_RT", weightKey: "2_VA_RT" },
    { key: "PLv_GVC", weightKey: "3_VA_GVC" },
  ],
};
const backward: DecompositionSpec = {
  total: "PLy",
  weightTotal: "FGY",
  parts: [
    { key: "PLy_D", weightKey: "1_FGY_D" },
    { key: "PLy_RT", weightKey: "2_FGY_RT" },
    { key: "PLy_GVC", weightKey: "3_FGY_GVC" },
  ],
};
const normalForward = {
  PLv: 1.3,
  SVA: 10,
  PLv_D: 1,
  "1_VA_D": 4,
  PLv_RT: 2,
  "2_VA_RT": 3,
  PLv_GVC: 1,
  "3_VA_GVC": 3,
};

describe("explicit demo entity and request identity", () => {
  test("global, invalid, and restored stale values never become a demo country", () => {
    const countries = ["CHN", "USA"];
    expect(explicitDemoCountry(countries, "")).toBeNull();
    expect(explicitDemoCountry(countries, "OLD")).toBeNull();
    expect(explicitDemoCountry(countries, null)).toBeNull();
    expect(explicitDemoCountry(countries, "CHN")).toBe("CHN");
  });

  test("suppresses stale country/year responses synchronously by request key", () => {
    const oldKey = decompositionRequestKey(2019, "CHN");
    const nextKey = decompositionRequestKey(2020, "USA");
    const response = { requestKey: oldKey, payload: [{ country: "CHN" }] };
    expect(matchingDecompositionResponse(response, oldKey)).toEqual([{ country: "CHN" }]);
    expect(matchingDecompositionResponse(response, nextKey)).toBeNull();
  });
});

describe("decomposition domain model", () => {
  test("keeps complete positive signed parts and certifies only their real closure", () => {
    const model = buildDecompositionModel({ total: 10, a: 12, b: -2 }, amount);
    expect(model.status).toBe("valid");
    expect(model.values).toEqual([12, -2]);
    expect(model.contributions).toEqual([12, -2]);
    expect(model.shares).toEqual([120, -20]);
    expect(model.closure).toBe(true);
  });

  test("keeps an all-zero direct row neutral without claiming proven structural zero", () => {
    const model = buildDecompositionModel({ total: 0, a: 0, b: 0 }, amount);
    expect(model.status).toBe("nonpositive-total");
    expect(model.reason).toBe("zero-total");
    expect(model.values).toEqual([0, 0]);
    expect(model.contributions).toEqual([0, 0]);
    expect(model.shares).toBeNull();
    expect(model.closure).toBeNull();
    expect(model.amountCloses).toBe(true);
    expect(directZeroTotalKind(model)).toBe("all-zero");
  });

  test("preserves complete signed amounts for zero or negative SVA without shares or green closure", () => {
    const zero = buildDecompositionModel({ total: 0, a: 2, b: -2 }, amount);
    expect(zero.status).toBe("nonpositive-total");
    expect(zero.values).toEqual([2, -2]);
    expect(zero.shares).toBeNull();
    expect(zero.closure).toBeNull();
    expect(directZeroTotalKind(zero)).toBe("signed-offset");

    const nonclosingZero = buildDecompositionModel({ total: 0, a: 2, b: -1 }, amount);
    expect(directZeroTotalKind(nonclosingZero)).toBe("nonclosing");
    const nearButNotExactOffset = buildDecompositionModel({ total: 0, a: 2, b: -1.9999995 }, amount);
    expect(nearButNotExactOffset.amountCloses).toBe(true);
    expect(directZeroTotalKind(nearButNotExactOffset)).toBe("nonclosing");

    const negative = buildDecompositionModel({ total: -5, a: -7, b: 2 }, amount);
    expect(negative.status).toBe("nonpositive-total");
    expect(negative.values).toEqual([-7, 2]);
    expect(negative.shares).toBeNull();
    expect(negative.closure).toBeNull();
    expect(negative.amountCloses).toBe(true);
  });

  test("preserves nullable direct contributions but never sums a partial row", () => {
    const model = buildDecompositionModel({ total: 3, a: 1, b: null }, amount);
    expect(model.status).toBe("unavailable");
    expect(model.contributions).toEqual([1, null]);
    expect(model.values).toBeNull();
    expect(model.sum).toBeNull();
    expect(model.closure).toBeNull();
  });

  test("never turns null, strings, NaN, or Infinity into zero", () => {
    for (const row of [
      { total: null, a: 1, b: 2 },
      { total: 3, a: "1", b: 2 },
      { total: 3, a: Number.NaN, b: 2 },
      { total: 3, a: Number.POSITIVE_INFINITY, b: 2 },
    ]) {
      const model = buildDecompositionModel(row, amount);
      expect(model.status).toBe("unavailable");
      expect(model.values).toBeNull();
      expect(model.sum).toBeNull();
      expect(model.closure).toBeNull();
    }
    expect(finiteNumber("0")).toBeNull();
    expect(finiteNumber(null)).toBeNull();
  });

  test("handles real three-part PLv and PLy weighted decompositions", () => {
    const plv = buildDecompositionModel(normalForward, forward);
    expect(plv.status).toBe("valid");
    expect(plv.contributions).toEqual([0.4, 0.6, 0.3]);
    expect(plv.sum).toBeCloseTo(1.3);
    expect(plv.closure).toBe(true);

    const ply = buildDecompositionModel({
      PLy: 2,
      FGY: 10,
      PLy_D: 1,
      "1_FGY_D": 2,
      PLy_RT: 2,
      "2_FGY_RT": 3,
      PLy_GVC: 3,
      "3_FGY_GVC": 4,
    }, backward);
    expect(ply.status).toBe("valid");
    expect(ply.contributions).toEqual([0.2, 0.6, 1.2]);
    expect(ply.closure).toBe(true);
  });

  test("requires a positive weight base while preserving finite partial contributions", () => {
    const zero = buildDecompositionModel({ ...normalForward, SVA: 0, PLv: null }, forward);
    expect(zero.reason).toBe("zero-weight-denominator");
    expect(zero.contributions).toEqual([null, null, null]);
    expect(zero.values).toBeNull();

    const negative = buildDecompositionModel({ ...normalForward, SVA: -1 }, forward);
    expect(negative.reason).toBe("negative-weight-denominator");
    expect(negative.shares).toBeNull();

    const partial = buildDecompositionModel({ ...normalForward, PLv_RT: null }, forward);
    expect(partial.reason).toBe("missing-fields");
    expect(partial.contributions).toEqual([0.4, null, 0.3]);
    expect(partial.values).toBeNull();
    expect(partial.sum).toBeNull();
    expect(partial.closure).toBeNull();
  });

  test("a purely domestic industry (no trade or GVC activity, undefined lengths) still decomposes", () => {
    const domestic = buildDecompositionModel({
      PLv: 1.5, SVA: 10, PLv_D: 1.5, "1_VA_D": 10, PLv_RT: null, "2_VA_RT": 0, PLv_GVC: null, "3_VA_GVC": 0,
    }, forward);
    expect(domestic.status).toBe("valid");
    expect(domestic.contributions).toEqual([1.5, 0, 0]);
    expect(domestic.closure).toBe(true);
  });

  test("rejects overflow in contributions, sums, errors, and shares", () => {
    const contributionOverflow = buildDecompositionModel({
      ...normalForward,
      PLv_D: Number.MAX_VALUE,
      "1_VA_D": 2,
    }, forward);
    expect(contributionOverflow.reason).toBe("nonfinite-calculation");
    expect(contributionOverflow.contributions[0]).toBeNull();
    expect(contributionOverflow.values).toBeNull();

    const sumOverflow = buildDecompositionModel(
      { total: Number.MAX_VALUE, a: Number.MAX_VALUE, b: Number.MAX_VALUE },
      amount,
    );
    expect(sumOverflow.reason).toBe("nonfinite-calculation");
    expect(sumOverflow.contributions).toEqual([Number.MAX_VALUE, Number.MAX_VALUE]);
    expect(sumOverflow.values).toBeNull();

    const shareOverflow = buildDecompositionModel(
      { total: Number.MIN_VALUE, a: Number.MAX_VALUE, b: -Number.MAX_VALUE },
      amount,
    );
    expect(shareOverflow.reason).toBe("nonfinite-calculation");
    expect(shareOverflow.values).toBeNull();
    expect(shareOverflow.shares).toBeNull();
  });

  test("carries authoritative totals into compare geometry and excludes incomplete sides", () => {
    const nonClosing = buildDecompositionModel({ total: 10, a: 6, b: 2 }, amount);
    expect(nonClosing.status).toBe("valid");
    expect(nonClosing.closure).toBe(false);
    expect(nonClosing.shares).toEqual([60, 20]);
    expect(decompositionDomainRows([
      { total: 10, a: 6, b: 2 },
      { total: 0, a: 2, b: -2 },
      { total: 3, a: null, b: 3 },
      null,
    ], amount)).toEqual([{ values: [6, 2], total: 10 }]);
  });

  test("keeps partial-null PLv/PLy/GVCPs unavailable instead of fabricating 0.000", () => {
    const plv = buildDecompositionModel({
      ...normalForward,
      PLv: null,
      PLv_RT: null,
      GVCPs: null,
    }, forward);
    expect(plv.status).toBe("unavailable");
    expect(plv.contributions).toEqual([0.4, null, 0.3]);
    expect(plv.values).toBeNull();
    expect(plv.shares).toBeNull();

    const ply = buildDecompositionModel({
      PLy: null,
      FGY: 0,
      PLy_D: null,
      "1_FGY_D": 0,
      PLy_RT: null,
      "2_FGY_RT": 0,
      PLy_GVC: null,
      "3_FGY_GVC": 0,
      GVCPs: null,
    }, backward);
    expect(ply.reason).toBe("zero-weight-denominator");
    expect(ply.values).toBeNull();
    expect(finiteNumber(null)).toBeNull();
  });
});
