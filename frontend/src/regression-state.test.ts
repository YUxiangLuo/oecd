import { describe, expect, test } from "bun:test";

import { restorablePlacebo, type RegressionSettings, type RegressionStepState } from "./regression";
import type { PlaceboResponse } from "./types";

const settings: RegressionSettings = {
  granularity: "country_industry",
  shockType: "tariff",
  method: "did",
  controlMode: "none",
  interaction: false,
  priceMode: "nominal",
  scenario: "clean",
  weightMode: "fixed_pretreatment",
};

const response = {
  design: { outcome: "network", method: "did" },
  placebo: {
    policy_name: "treated×post",
    true_coef: -1.2,
    placebo_coefs: [-0.2, 0.1],
    empirical_p: 0.05,
    n_draws: 2,
    requested_draws: 10,
    seed: 2026,
    treated_entities: 10,
    total_entities: 100,
    cohorts: { "2019": 10 },
    note: "test",
  },
  disclaimer: "test",
} as unknown as PlaceboResponse;

function state(savedResponse: PlaceboResponse = response): RegressionStepState {
  return { placebo_run: { settings, response: savedResponse }, placebo_id: "signed" };
}

describe("placebo session restoration", () => {
  test("restores the exact randomized result for matching main-run settings", () => {
    expect(restorablePlacebo(state(), settings)).toBe(response);
  });

  test("does not attach an old placebo to a different main-run design", () => {
    expect(restorablePlacebo(state(), { ...settings, controlMode: "icio_derived" })).toBeNull();
  });

  test("rejects malformed local-session result data instead of crashing the chart", () => {
    const malformed = { ...response, placebo: { ...response.placebo, empirical_p: Number.NaN } };
    const impossible = { ...response, placebo: { ...response.placebo, empirical_p: 1.5 } };
    expect(restorablePlacebo(state(malformed), settings)).toBeNull();
    expect(restorablePlacebo(state(impossible), settings)).toBeNull();
  });
});
