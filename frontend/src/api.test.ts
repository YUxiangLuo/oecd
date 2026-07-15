import { describe, expect, test } from "bun:test";

import { shouldExpireAuth, withQuery } from "./api";

describe("auth expiration", () => {
  test("a delayed 401 can only expire the token used by that request", () => {
    expect(shouldExpireAuth("old-token", "old-token")).toBe(true);
    expect(shouldExpireAuth("old-token", "new-token")).toBe(false);
    expect(shouldExpireAuth(null, "new-token")).toBe(false);
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
