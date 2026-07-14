import { describe, expect, test } from "bun:test";

import { withQuery } from "./api";

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
