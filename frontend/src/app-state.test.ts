import { describe, expect, test } from "bun:test";
import { AUTH_TOKEN_KEY } from "./api";
import {
  clearAuthentication,
  clearAuthenticationIfCurrent,
  dropStepFromHistory,
  stepFromSearch,
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

  test("drops only the step from the current entry when the account changes", () => {
    const calls: string[] = [];
    const history = {
      pushState: () => calls.push("push"),
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => calls.push(`replace:${String(url)}`),
    };
    dropStepFromHistory(history, "https://example.test/lab?mode=demo&step=7#chart");
    expect(calls).toEqual(["replace:/lab?mode=demo#chart"]);
  });
});

describe("application authentication storage", () => {
  test("stores and clears just the tab token", () => {
    const storage = new MemoryStorage();
    storeAuthentication(storage, "signed-token");
    expect([...storage.values.keys()]).toEqual([AUTH_TOKEN_KEY]);
    clearAuthentication(storage);
    expect(storage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  test("a delayed logout cannot delete a newer login", () => {
    const storage = new MemoryStorage();
    storeAuthentication(storage, "token-b");
    expect(clearAuthenticationIfCurrent(storage, "token-a")).toBe(false);
    expect(storage.getItem(AUTH_TOKEN_KEY)).toBe("token-b");
    expect(clearAuthenticationIfCurrent(storage, "token-b")).toBe(true);
    expect(storage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  test("logging out of one tab leaves another tab's login intact", () => {
    const a = new MemoryStorage();
    const b = new MemoryStorage();
    storeAuthentication(a, "student-a");
    storeAuthentication(b, "teacher-b");
    clearAuthentication(b);
    expect(a.getItem(AUTH_TOKEN_KEY)).toBe("student-a");
    expect(b.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });
});

describe("intro auto-show", () => {
  test("every student login shows the intro, regardless of account history", () => {
    expect(shouldAutoShowIntro("student")).toBe(true);
    // 不按账号记忆已读：同一账号下次登录仍然展示。
    expect(shouldAutoShowIntro("student")).toBe(true);
    expect(shouldAutoShowIntro("teacher")).toBe(false);
    expect(shouldAutoShowIntro("")).toBe(false);
  });
});
