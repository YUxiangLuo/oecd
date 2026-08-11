import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptySession, readShared, readStep } from "./session-store";
import {
  patchSessionStep,
  sessionScope,
  sessionScopeKey,
  updateSessionShared,
  useSession,
} from "./use-session";

describe("sessionScope", () => {
  test("requires a stable account and manifest id", () => {
    expect(sessionScope(
      { username: "student", accountId: 42 },
      { manifestId: "manifest" },
    )).toEqual({ accountId: 42, manifestId: "manifest" });
  });

  test("fails closed instead of caching under username-only fallbacks", () => {
    expect(sessionScope(
      { username: "student" },
      { manifestId: "manifest" },
    )).toBeNull();
    expect(sessionScope({ username: "student", accountId: 42 }, null)).toBeNull();
  });

  test("keys the retry queue by account and manifest boundaries", () => {
    const base = sessionScopeKey({
      accountId: 42,
      manifestId: "manifest",
    });

    expect(base).not.toBe(sessionScopeKey({
      accountId: 43,
      manifestId: "manifest",
    }));
    expect(base).not.toBe(sessionScopeKey({
      accountId: 42,
      manifestId: "other-manifest",
    }));
  });

  test("normalizes numeric API ids without weakening scope isolation", () => {
    expect(sessionScopeKey({
      accountId: 42,
      manifestId: "manifest",
    })).toBe(sessionScopeKey({
      accountId: "42",
      manifestId: "manifest",
    }));
    expect(sessionScopeKey(null)).toBeNull();
  });
});

describe("session loading state", () => {
  test("settles as unavailable when metadata has no manifest to load", () => {
    function StatusProbe() {
      return createElement("span", null, useSession(
        { username: "student", accountId: 42 },
        null,
      ).status);
    }

    expect(renderToStaticMarkup(createElement(StatusProbe))).toContain("unavailable");
  });
});

describe("atomic session updates", () => {
  test("two same-tick style step patches keep fields from both producers", () => {
    let session = emptySession("manifest");
    session = patchSessionStep(session, 7, { chart: "quadrant", compared: ["CHN", "USA"] });
    session = patchSessionStep(session, 7, { metric: "FVA_share", observations: [1, 2] });

    expect(readStep(session, 7)).toMatchObject({
      chart: "quadrant",
      compared: ["CHN", "USA"],
      metric: "FVA_share",
      observations: [1, 2],
    });
  });

  test("functional shared updates compose on the latest record", () => {
    let session = emptySession("manifest");
    session = updateSessionShared<Record<string, number>>(session, "regression_history", (current) => ({
      ...(current ?? {}),
      trade: 1,
    }));
    session = updateSessionShared<Record<string, number>>(session, "regression_history", (current) => ({
      ...(current ?? {}),
      network: 2,
    }));

    expect(readShared<Record<string, number>>(session, "regression_history")).toEqual({ trade: 1, network: 2 });
  });
});
