import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { AUTH_TOKEN_KEY, setActiveAuthToken } from "./api";

const restorers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const restore of restorers.splice(0).reverse()) restore();
  localStorage.removeItem(AUTH_TOKEN_KEY);
  setActiveAuthToken(null);
});

function retainedLogin() {
  localStorage.setItem(AUTH_TOKEN_KEY, "valid-session");
  setActiveAuthToken("valid-session");
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  restorers.push(() => reload.mockRestore());
  return reload;
}

describe("authentication dependency recovery", () => {
  for (const status of [500, 503]) {
    test(`a ${status} during boot retains authentication and offers retry`, async () => {
      const reload = retainedLogin();
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "教学数据库暂时不可用" }), {
        status, headers: { "Content-Type": "application/json" },
      }));
      restorers.push(() => fetch.mockRestore());
      render(<App />);
      await waitFor(() => expect(screen.getByRole("button", { name: "重试连接" })).toBeTruthy());
      expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe("valid-session");
      expect(reload).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("密码")).toBeNull();
    });
  }

  test("a genuine 401 still clears the expired authentication", async () => {
    const reload = retainedLogin();
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "令牌已过期" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    }));
    restorers.push(() => fetch.mockRestore());
    render(<App />);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });
});
