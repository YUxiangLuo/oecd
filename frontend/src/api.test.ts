import { describe, expect, jest, test } from "bun:test";

import { api, getActiveAuthToken, setActiveAuthToken, withQuery } from "./api";
import { emptySession } from "./session-store";
import type { AuthUser } from "./types";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (key: string) => this.map.get(key) ?? null;
  setItem = (key: string, value: string) => void this.map.set(key, String(value));
  removeItem = (key: string) => void this.map.delete(key);
  clear = () => this.map.clear();
}

if (typeof globalThis.localStorage === "undefined") {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
}
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: EventTarget }).window = globalThis;
}

function authUser(username: string): AuthUser {
  return { username, name: username, role: "student" };
}

describe("auth expiration", () => {
  test("logout is local-only and has no API method", () => {
    expect("logout" in api).toBe(false);
  });

  test("a mounted tab keeps its validated token when shared storage changes", () => {
    const originalToken = localStorage.getItem("gvcsim_token");
    try {
      setActiveAuthToken("token-a");
      localStorage.setItem("gvcsim_token", "token-b");
      expect(getActiveAuthToken()).toBe("token-a");
    } finally {
      setActiveAuthToken(originalToken);
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
    }
  });

  test("an active-token 401 expires the mounted session", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = localStorage.getItem("gvcsim_token");
    let events = 0;
    const onExpired = () => events += 1;
    globalThis.addEventListener("gvcsim-auth-expired", onExpired);
    try {
      setActiveAuthToken("active-token");
      localStorage.setItem("gvcsim_token", "active-token");
      globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

      await expect(api.me("active-token")).rejects.toThrow("expired");
      expect(getActiveAuthToken()).toBeNull();
      expect(localStorage.getItem("gvcsim_token")).toBeNull();
      expect(events).toBe(1);
    } finally {
      globalThis.removeEventListener("gvcsim-auth-expired", onExpired);
      setActiveAuthToken(originalToken);
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
      globalThis.fetch = originalFetch;
    }
  });

  test("a stale-token 401 does not expire the mounted session", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = localStorage.getItem("gvcsim_token");
    let events = 0;
    const onExpired = () => events += 1;
    globalThis.addEventListener("gvcsim-auth-expired", onExpired);
    try {
      setActiveAuthToken("active-token");
      localStorage.setItem("gvcsim_token", "active-token");
      globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

      await expect(api.me("stale-token")).rejects.toThrow("expired");
      expect(getActiveAuthToken()).toBe("active-token");
      expect(localStorage.getItem("gvcsim_token")).toBe("active-token");
      expect(events).toBe(0);
    } finally {
      globalThis.removeEventListener("gvcsim-auth-expired", onExpired);
      setActiveAuthToken(originalToken);
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
      globalThis.fetch = originalFetch;
    }
  });

  test("mutations use the mounted tab token, not another tab's stored token", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = localStorage.getItem("gvcsim_token");
    let authorization: string | null = null;
    try {
      setActiveAuthToken("token-a");
      localStorage.setItem("gvcsim_token", "token-b");
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      await api.classroom.saveSession({ session: emptySession(), base_updated_at: null });
      expect(String(authorization)).toBe("Bearer token-a");
    } finally {
      setActiveAuthToken(originalToken);
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
      globalThis.fetch = originalFetch;
    }
  });
});

describe("login requests", () => {
  test("times out login after 10 seconds and retries only when called again", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    jest.useFakeTimers();
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(new Response(JSON.stringify({
          token: "token",
          user: authUser("student"),
          expires_at: 1,
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    try {
      const stalled = api.login("student", "password");
      jest.advanceTimersByTime(10_000);
      await expect(stalled).rejects.toThrow("请求超时（10 秒）");
      expect(calls).toBe(1);
      expect((await api.login("student", "password")).token).toBe("token");
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("mutations", () => {
  test("times out response parsing after 120 seconds and allows a manual retry without automatic calls", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let firstSignal: AbortSignal | null = null;
    let markJsonStarted: () => void = () => undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    jest.useFakeTimers();
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      firstSignal = init?.signal ?? null;
      return Promise.resolve({
        ok: true,
        json: () => {
          markJsonStarted();
          return new Promise<never>(() => undefined);
        },
      } as unknown as Response);
    }) as unknown as typeof fetch;
    try {
      const stalled = api.classroom.submitReport();
      await jsonStarted;
      jest.advanceTimersByTime(120_000);
      await expect(stalled).rejects.toThrow("请求超时（120 秒）");
      expect(firstSignal).not.toBeNull();
      expect((firstSignal as unknown as AbortSignal).aborted).toBe(true);
      expect(calls).toBe(1);
      await api.classroom.submitReport();
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET requests", () => {
  test("recovers from transient gateway failures within three attempts", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls < 3
        ? new Response("gateway busy", { status: calls === 1 ? 502 : 504 })
        : new Response(JSON.stringify(authUser("recovered")), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await api.me("valid-token")).toEqual(authUser("recovered"));
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stops after three busy responses and never retries a mutation", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ detail: "busy" }), { status: 503 });
    }) as unknown as typeof fetch;
    try {
      await expect(api.me("valid-token")).rejects.toThrow("busy");
      expect(calls).toBe(3);
      await expect(api.classroom.submitReport()).rejects.toThrow("busy");
      expect(calls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cancelling a busy request stops its Retry-After wait and further attempts", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let calls = 0;
    let signal: AbortSignal | null = null;
    let received!: () => void;
    const responseReceived = new Promise<void>((resolve) => { received = resolve; });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      signal = init?.signal ?? null;
      received();
      return new Response("{}", { status: 503, headers: { "Retry-After": "5" } });
    }) as typeof fetch;
    try {
      const request = api.dbMeta(controller.signal);
      await responseReceived;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
      controller.abort();
      await expect(request).rejects.toThrow("请求已取消");
      expect((signal as unknown as AbortSignal).aborted).toBe(true);
      await expect(api.dbMeta(controller.signal)).rejects.toThrow("请求已取消");
      expect(calls).toBe(1);
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
    }
  });

  test("times out a stalled GET and allows a later retry", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    jest.useFakeTimers();
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(new Response(JSON.stringify(authUser("after-timeout")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    try {
      const stalled = api.me("timeout-token");
      jest.advanceTimersByTime(10_000);
      await expect(stalled).rejects.toThrow("请求超时（10 秒）");
      expect(await api.me("timeout-token")).toEqual(authUser("after-timeout"));
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("single-entity indicator requests", () => {
  test("rejects global scope before it can call fetch", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(api.countryIndicatorsForCountry(2020, "")).rejects.toThrow("必须指定国家");
      await expect(api.industryIndicatorsAll(2020, "")).rejects.toThrow("必须指定国家");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requests a complete explicit-country network page without changing global pagination", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ total: 0, page: 1, page_size: 25, rows: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await api.industryIndicators(2020, "CHN", 1, 200);
      await api.industryIndicators(2020, "", 3);
      expect(urls[0]).toBe("/api/indicators/industry/2020?page=1&page_size=200&country=CHN");
      expect(urls[1]).toBe("/api/indicators/industry/2020?page=3");
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

  test("shock panel sends the typed filter and never the ambiguous only_hit parameter", async () => {
    const originalFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify({ total: 0, page: 1, page_size: 25, rows: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await api.shockPanel(2020, "sanctions", "CHN", "C26", "treated", "country_asc", 2);
      expect(requested).toContain("filter=treated");
      expect(requested).toContain("sort=country_asc");
      expect(requested).not.toContain("only_hit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("unavailable server responses", () => {
  test("proxy failures provide a recovery message without expiring auth", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = getActiveAuthToken();
    try {
      setActiveAuthToken("still-valid");
      for (const status of [500, 502, 503, 504]) {
        globalThis.fetch = (async () => new Response("Internal Server Error", { status })) as unknown as typeof fetch;
        for (const operation of [() => api.login("student", "password"), () => api.me("still-valid"), () => api.classroom.submitReport()]) {
          await expect(operation()).rejects.toThrow("服务暂时不可用，请稍后重试");
          expect(getActiveAuthToken()).toBe("still-valid");
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      setActiveAuthToken(originalToken);
    }
  });
});
