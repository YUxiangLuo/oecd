import { expect, test } from "bun:test";
import { observationRequestIdentity, persistableVizYear, restoreVizState, sameObservationIdentity } from "./scaffold";

const meta = { years: [2018, 2019, 2020], countries: ["CHN", "USA"] };
test("network browsing restores only valid selections", () => {
  expect(restoreVizState(meta, { chart: "heat", year: 2019, compared: ["USA", "UNKNOWN"] }, "network", ["network", "heat"]))
    .toEqual({ year: 2019, lens: "heat", picked: ["USA"] });
  expect(restoreVizState(meta, { chart: "removed", year: 2016 }, "network", ["network", "heat"]))
    .toEqual({ year: 2020, lens: "network", picked: [] });
  expect(persistableVizYear(meta.years, NaN)).toBe(2020);
});

test("request identities separate release, year, country and retry", () => {
  const release = { dataset: { years: meta.years, release_id: "a".repeat(32) } };
  const identity = observationRequestIdentity(release, 2020, "country-industry", 0, "CHN");
  expect(sameObservationIdentity(identity, observationRequestIdentity(release, 2020, "country-industry", 0, "CHN"))).toBe(true);
  for (const next of [
    observationRequestIdentity(release, 2019, "country-industry", 0, "CHN"),
    observationRequestIdentity(release, 2020, "country-industry", 0, "USA"),
    observationRequestIdentity(release, 2020, "country-industry", 1, "CHN"),
    observationRequestIdentity({ dataset: null }, 2020, "country-industry", 0, "CHN"),
  ]) expect(sameObservationIdentity(identity, next)).toBe(false);
});
