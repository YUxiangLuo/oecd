import { describe, expect, test } from "bun:test";
import type { StepStateApi } from "../../../types";
import {
  addInspectedCountry,
  countryObservationPatch,
  invalidateVizObservations,
  observationRequestIdentity,
  persistableVizYear,
  restoreVizState,
  type BoundRows,
  type VizStepState,
} from "./scaffold";

const meta = { years: [2018, 2019, 2020], countries: ["CHN", "SGP", "USA"] };
const releaseMeta = {
  ...meta,
  dataset: { years: meta.years, release_id: "a".repeat(32) },
};

describe("restoreVizState", () => {
  test("restores saved lens, year and picked countries", () => {
    expect(restoreVizState(meta, {
      chart: "industry",
      year: 2019,
      compared: ["SGP", "USA"],
    }, "ladder", ["ladder", "rank", "industry"])).toEqual({
      year: 2019,
      lens: "industry",
      picked: ["SGP", "USA"],
    });
  });

  test("refuses a year the current release does not contain", () => {
    expect(persistableVizYear(meta.years, 0)).toBe(2020);
    expect(persistableVizYear(meta.years, Number.NaN)).toBe(2020);
    expect(persistableVizYear(meta.years, 2019)).toBe(2019);
    expect(restoreVizState(meta, { year: 0, chart: "ladder" }, "ladder", ["ladder"]).year).toBe(2020);
  });

  test("records a newly inspected country without dropping earlier ones", () => {
    expect(addInspectedCountry(["CHN"], "USA", meta.countries)).toEqual(["CHN", "USA"]);
    expect(addInspectedCountry(["CHN"], "CHN", meta.countries)).toEqual(["CHN"]);
    expect(addInspectedCountry(["CHN"], "XXX", meta.countries)).toEqual(["CHN"]);
  });

  test("drops values that do not belong to the current dataset metadata", () => {
    expect(restoreVizState(meta, {
      chart: "removed-lens",
      year: 2016,
      compared: ["CHN", "XXX"],
    }, "ladder", ["ladder", "rank", "industry"])).toEqual({
      year: 2020,
      lens: "ladder",
      picked: ["CHN"],
    });
  });
});

describe("request-bound country observations", () => {
  const identity = observationRequestIdentity(releaseMeta, 2020, "country", 2)!;
  const response: BoundRows = {
    identity,
    rows: [
      { country: "CHN", FVA_share: 0.25 },
      { country: "SGP", FVA_share: null },
      { country: "USA", FVA_share: Number.POSITIVE_INFINITY },
    ],
  };

  test("saves finite picked values with durable request and metric provenance", () => {
    expect(countryObservationPatch(response, identity, ["CHN", "SGP", "USA"], "FVA_share")).toEqual({
      metric: "FVA_share",
      observations: [{
        entity: "CHN",
        country: "CHN",
        year: 2020,
        value: 0.25,
        metric: "FVA_share",
        release: "a".repeat(32),
        scope: "country",
        generation: 2,
        request_key: `${"a".repeat(32)}:2020:country:`,
      }],
    });
  });

  test("rejects release, year, scope and generation mismatches", () => {
    const mismatches = [
      observationRequestIdentity({ ...releaseMeta, dataset: { ...releaseMeta.dataset, release_id: "b".repeat(32) } }, 2020, "country", 2),
      observationRequestIdentity(releaseMeta, 2019, "country", 2),
      observationRequestIdentity(releaseMeta, 2020, "country-industry", 2, "CHN"),
      observationRequestIdentity(releaseMeta, 2020, "country", 3),
    ];
    for (const expected of mismatches) {
      expect(countryObservationPatch(response, expected, ["CHN"], "FVA_share").observations).toEqual([]);
    }
  });

  test("missing release, missing response and empty selection clear observations", () => {
    expect(observationRequestIdentity({ dataset: null }, 2020, "country", 0)).toBeNull();
    expect(countryObservationPatch(null, identity, ["CHN"], "FVA_share").observations).toEqual([]);
    expect(countryObservationPatch(response, identity, [], "FVA_share").observations).toEqual([]);
  });

  test("year/selection handlers can invalidate persisted evidence synchronously", () => {
    const patches: Partial<VizStepState>[] = [];
    const state: StepStateApi<VizStepState> = {
      data: { observations: [{ entity: "CHN", country: "CHN", year: 2019, value: 1 }] },
      save: (patch) => { patches.push(patch); },
      complete: false,
      syncing: false,
      syncError: null,
      syncNow: () => {},
    };
    invalidateVizObservations(state);
    expect(patches).toEqual([{ observations: [] }]);
  });
});
