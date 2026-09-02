import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HEAT_VIEW,
  HEAT_EVIDENCE_METRIC,
  HEAT_WEIGHTED_DEGREE_METRIC,
  heatActivationForRow,
  heatRowKey,
} from "../../../viz/views/network-heat";
import type { ObservationRequestIdentity, Row, VizObservation } from "./scaffold";
import {
  heatObservationFromActivation,
  nextExplicitHeatObservations,
  STEP10_DEFAULT_LENS,
  STEP10_LENSES,
} from "./network";

describe("step 9 network lenses", () => {
  test("opens with the trade network first for a new session", () => {
    expect(STEP10_DEFAULT_LENS).toBe("network");
    expect(STEP10_LENSES.map(({ key }) => key)).toEqual(["network", "heat"]);
  });
});

describe("step 9 explicit heat evidence", () => {
  const identity: ObservationRequestIdentity = {
    release: "a".repeat(32),
    year: 2020,
    scope: "country-industry",
    country: "CHN",
    generation: 1,
    requestKey: `${"a".repeat(32)}:2020:country-industry:CHN`,
  };
  const rows: Row[] = [
    { country: "CHN", industry: "low", [HEAT_EVIDENCE_METRIC]: 1 },
    { country: "CHN", industry: "visible", [HEAT_EVIDENCE_METRIC]: 8 },
  ];
  const activation = heatActivationForRow(rows, heatRowKey(rows[1]))!;

  test("saves the exact explicitly activated visible row with report-compatible provenance", () => {
    expect(heatObservationFromActivation(activation, identity, identity, rows, DEFAULT_HEAT_VIEW)).toEqual({
      entity: "CHN·visible",
      country: "CHN",
      industry: "visible",
      year: 2020,
      value: 8,
      metric: HEAT_EVIDENCE_METRIC,
      release: "a".repeat(32),
      scope: "country-industry",
      generation: 1,
      request_key: identity.requestKey,
      source: "explicit-heat-row",
    });
  });

  test("rejects a queued activation after year, country or retry generation changes", () => {
    const changed: ObservationRequestIdentity[] = [
      { ...identity, year: 2019, requestKey: `${"a".repeat(32)}:2019:country-industry:CHN` },
      { ...identity, country: "USA", requestKey: `${"a".repeat(32)}:2020:country-industry:USA` },
      { ...identity, generation: 2 },
    ];
    for (const current of changed) {
      expect(heatObservationFromActivation(activation, identity, current, rows, DEFAULT_HEAT_VIEW)).toBeNull();
    }
  });

  test("rejects fabricated, nonvisible, or wrong-country activations", () => {
    expect(heatObservationFromActivation(
      { ...activation, visibleIndex: 0, rowKey: "CHN\u0000not-visible" },
      identity,
      identity,
      rows,
      DEFAULT_HEAT_VIEW,
    )).toBeNull();
    const mixedRows: Row[] = [{ country: "USA", industry: "visible", [HEAT_EVIDENCE_METRIC]: 8 }];
    const mixedActivation = heatActivationForRow(mixedRows, heatRowKey(mixedRows[0]))!;
    expect(heatObservationFromActivation(
      mixedActivation, identity, identity, mixedRows, DEFAULT_HEAT_VIEW,
    )).toBeNull();
  });

  test("rejects an activation queued under an old sort or coverage view", () => {
    const viewRows: Row[] = Array.from({ length: 20 }, (_, index) => ({
      country: "CHN",
      industry: `I${index}`,
      [HEAT_EVIDENCE_METRIC]: index,
      [HEAT_WEIGHTED_DEGREE_METRIC]: 20 - index,
    }));
    const weightedAll = { sortMetric: HEAT_WEIGHTED_DEGREE_METRIC, coverage: "all" as const };
    const queued = heatActivationForRow(
      viewRows,
      heatRowKey(viewRows[0]),
      weightedAll.sortMetric,
      weightedAll.coverage,
    )!;
    expect(heatObservationFromActivation(queued, identity, identity, viewRows, weightedAll)?.industry).toBe("I0");
    expect(heatObservationFromActivation(queued, identity, identity, viewRows, DEFAULT_HEAT_VIEW)).toBeNull();
    expect(heatObservationFromActivation(
      { ...queued, visibleIndex: 1 }, identity, identity, viewRows, weightedAll,
    )).toBeNull();
    expect(heatObservationFromActivation(
      { ...queued, row: { ...queued.row, [HEAT_EVIDENCE_METRIC]: -999 } },
      identity,
      identity,
      viewRows,
      weightedAll,
    )).toBeNull();
  });

  test("keeps at most two explicitly activated countries and drops legacy auto rows", () => {
    const observation = (country: string): VizObservation => ({
      entity: `${country}·I01`, country, industry: "I01", year: 2020, value: 1,
      metric: HEAT_EVIDENCE_METRIC, source: "explicit-heat-row",
      release: "a".repeat(32), scope: "country-industry", generation: 1,
      request_key: `${"a".repeat(32)}:2020:country-industry:${country}`,
    });
    const legacy: VizObservation = { entity: "legacy", country: "OLD", year: 2020, value: 1 };
    const oldRelease = { ...observation("OLD"), release: "b".repeat(32) };
    const first = nextExplicitHeatObservations([legacy, oldRelease], observation("CHN"));
    const second = nextExplicitHeatObservations(first, observation("USA"));
    const third = nextExplicitHeatObservations(second, observation("DEU"));
    expect(first.map((item) => item.country)).toEqual(["CHN"]);
    expect(second.map((item) => item.country)).toEqual(["CHN", "USA"]);
    expect(third.map((item) => item.country)).toEqual(["USA", "DEU"]);
  });
});
