import { describe, expect, test } from "bun:test";
import { AUTH_TOKEN_KEY } from "./api";
import {
  AUTH_EXPIRES_KEY,
  clearAuthentication,
  readAuthExpiry,
  stepFromSearch,
  storeAuthentication,
  urlWithoutStep,
  urlWithStep,
} from "./app-state";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("application URL state", () => {
  test("accepts only the fixed 16-step range", () => {
    expect(stepFromSearch("?step=1")).toBe(1);
    expect(stepFromSearch("?step=16")).toBe(16);
    for (const search of ["", "?step=0", "?step=17", "?step=1.5", "?step=bad"]) {
      expect(stepFromSearch(search)).toBeNull();
    }
  });

  test("updates only the step query while preserving other URL state", () => {
    expect(urlWithStep("https://example.test/lab?mode=demo#chart", 7))
      .toBe("/lab?mode=demo&step=7#chart");
    expect(urlWithoutStep("https://example.test/lab?mode=demo&step=7#chart"))
      .toBe("/lab?mode=demo#chart");
  });
});

describe("application authentication storage", () => {
  test("stores, reads and clears the token pair together", () => {
    const storage = new MemoryStorage();
    storeAuthentication(storage, "signed-token", 12345);
    expect(storage.getItem(AUTH_TOKEN_KEY)).toBe("signed-token");
    expect(readAuthExpiry(storage)).toBe(12345);

    clearAuthentication(storage);
    expect(storage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    expect(storage.getItem(AUTH_EXPIRES_KEY)).toBeNull();
    expect(readAuthExpiry(storage)).toBeNull();
  });

  test("rejects absent, non-finite and non-positive expiry values", () => {
    const storage = new MemoryStorage();
    for (const value of ["", "not-a-number", "0", "-1", "Infinity"]) {
      storage.setItem(AUTH_EXPIRES_KEY, value);
      expect(readAuthExpiry(storage)).toBeNull();
    }
  });
});
