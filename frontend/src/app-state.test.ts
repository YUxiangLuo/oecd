import { describe, expect, test } from "bun:test";
import { AUTH_TOKEN_KEY } from "./api";
import {
  AUTH_EXPIRES_KEY,
  clearAuthentication,
  clearAuthenticationIfCurrent,
  isExternalAuthenticationChange,
  readAuthExpiry,
  stepFromSearch,
  markIntroSeen,
  shouldAutoShowIntro,
  storeAuthentication,
  urlWithStep,
  writeStepHistory,
} from "./app-state";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("application URL state", () => {
  test("accepts only the fixed 15-step range", () => {
    expect(stepFromSearch("?step=1")).toBe(1);
    expect(stepFromSearch("?step=15")).toBe(15);
    expect(stepFromSearch("?step=16")).toBeNull();
    for (const search of ["", "?step=0", "?step=17", "?step=1.5", "?step=bad"]) {
      expect(stepFromSearch(search)).toBeNull();
    }
  });

  test("updates only the step query while preserving other URL state", () => {
    expect(urlWithStep("https://example.test/lab?mode=demo#chart", 7))
      .toBe("/lab?mode=demo&step=7#chart");
  });

  test("pushes user step changes, replaces canonicalization, and skips duplicate entries", () => {
    const calls: string[] = [];
    const history = {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => calls.push(`push:${String(url)}`),
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => calls.push(`replace:${String(url)}`),
    };

    expect(writeStepHistory(history, "https://example.test/lab?mode=demo&step=2", 3, "push")).toBe(true);
    expect(writeStepHistory(history, "https://example.test/lab?mode=demo", 7, "replace")).toBe(true);
    expect(writeStepHistory(history, "https://example.test/lab?mode=demo&step=3", 3, "push")).toBe(false);
    expect(calls).toEqual([
      "push:/lab?mode=demo&step=3",
      "replace:/lab?mode=demo&step=7",
    ]);
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

  test("detects an external account switch without deleting the newer login", () => {
    const storage = new MemoryStorage();
    storeAuthentication(storage, "token-b", 23456);
    expect(isExternalAuthenticationChange(AUTH_TOKEN_KEY, "token-b", "token-a")).toBe(true);
    expect(isExternalAuthenticationChange(AUTH_EXPIRES_KEY, "23456", "token-a")).toBe(false);
    expect(clearAuthenticationIfCurrent(storage, "token-a")).toBe(false);
    expect(storage.getItem(AUTH_TOKEN_KEY)).toBe("token-b");
  });

  test("rejects absent, non-finite and non-positive expiry values", () => {
    const storage = new MemoryStorage();
    for (const value of ["", "not-a-number", "0", "-1", "Infinity"]) {
      storage.setItem(AUTH_EXPIRES_KEY, value);
      expect(readAuthExpiry(storage)).toBeNull();
    }
  });
});

describe("intro auto-show", () => {
  test("shows the intro once per username until it is dismissed", () => {
    const storage = new MemoryStorage();
    expect(shouldAutoShowIntro(storage, "student")).toBe(true);
    markIntroSeen(storage, "student");
    expect(shouldAutoShowIntro(storage, "student")).toBe(false);
    expect(shouldAutoShowIntro(storage, "edge")).toBe(true);
  });
});
