import { describe, expect, test } from "bun:test";
import { emptySession, isValidSession, patchStep, readShared, readStep, sameMaterialContent, sessionData, withSessionViews, writeShared } from "./session-store";
import { SESSION_VERSION } from "./types";

describe("simple session store", () => {
  test("material sync ignores browsing and quiz changes but tracks recorded evidence, labels and analysis", () => {
    expect(sameMaterialContent(undefined, { browse_selection: { first: "JPN" }, quiz: { answers: { q: "a" } } })).toBe(true);
    const saved = { observations: [{ country: "CHN", value: 12 }], material_label: "CHN 12", material_chosen: true };
    expect(sameMaterialContent(saved, { ...saved, network_browse: { countries: ["USA"] }, custom_draft: { baseline: "other" } })).toBe(true);
    expect(sameMaterialContent(saved, { ...saved, observations: [{ country: "CHN", value: 13 }] })).toBe(false);
    expect(sameMaterialContent(saved, { ...saved, material_label: "updated label" })).toBe(false);
    expect(sameMaterialContent(saved, { ...saved, experiment: { baseline: "other", spec: {} } })).toBe(false);
    expect(sameMaterialContent({ research_question: "old" }, { research_question: "new" })).toBe(false);
    expect(sameMaterialContent(saved, undefined)).toBe(false);
  });

  test("creates the fixed minimal contract", () => {
    expect(emptySession()).toEqual({ version: SESSION_VERSION, steps: {}, shared: {} });
  });

  test("patches fields without timestamps or merge metadata", () => {
    let session = patchStep(emptySession(), 4, { year: 2019, metric: "FVA" });
    session = patchStep(session, 4, { metric: "DVA", year: undefined });
    expect(readStep<Record<string, unknown>>(session, 4)).toEqual({ metric: "DVA" });
  });

  test("only accepts the one shared setting key", () => {
    const session = writeShared(emptySession(), "regression_settings", { trade: { method: "did" } });
    expect(readShared<Record<string, unknown>>(session, "regression_settings")).toEqual({ trade: { method: "did" } });
    expect(isValidSession(session)).toBe(true);
    expect(isValidSession({ ...session, shared: { regression_history: { data: {} } } })).toBe(false);
  });
});

test("local preferences cannot replace evidence or remove submitted quiz results", () => {
  const work = patchStep(emptySession(), 7, { observations: [17], quiz: { version: "v1" }, browse_selection: { first: "CAN" } });
  const local = patchStep(emptySession(), 7, { observations: [999], browse_selection: { first: "FIN" } });
  const restored = withSessionViews(sessionData(work), local);
  expect(readStep<Record<string, unknown>>(restored, 7)).toEqual({ observations: [17], quiz: { version: "v1" }, browse_selection: { first: "FIN" } });
  expect(sessionData(restored)).toEqual(patchStep(emptySession(), 7, { observations: [17], quiz: { version: "v1" } }));
  expect(sessionData(patchStep(emptySession(), 11, { custom_draft: { baseline: "FVA_share" } }))).toEqual(emptySession());
});
