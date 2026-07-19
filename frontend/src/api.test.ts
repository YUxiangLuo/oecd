import { describe, expect, test } from "bun:test";

import { api, shouldExpireAuth, withQuery } from "./api";

describe("auth expiration", () => {
  test("a delayed 401 can only expire the token used by that request", () => {
    expect(shouldExpireAuth("old-token", "old-token")).toBe(true);
    expect(shouldExpireAuth("old-token", "new-token")).toBe(false);
    expect(shouldExpireAuth(null, "new-token")).toBe(false);
  });

  test("logout revokes the exact server token", async () => {
    const originalFetch = globalThis.fetch;
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await api.logout("signed-token");
      expect(seen[0]?.url).toBe("/api/auth/logout");
      expect(seen[0]?.init?.method).toBe("POST");
      expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer signed-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("withQuery", () => {
  test("encodes every user-controlled query value", () => {
    const url = withQuery("/api/items", {
      country: "A&B",
      sector: "C+26",
      enabled: false,
      page: 2,
      empty: "",
      missing: undefined,
    });
    expect(url).toBe("/api/items?country=A%26B&sector=C%2B26&enabled=false&page=2");
  });

  test("does not append an empty question mark", () => {
    expect(withQuery("/api/items", { country: null })).toBe("/api/items");
  });
});
