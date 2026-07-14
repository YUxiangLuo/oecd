import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 980 },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "bun run dev -- --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    ...(process.env.REAL_API
      ? [{
          command: "cd .. && uv run uvicorn gvcsim.api:app --host 127.0.0.1 --port 8000",
          url: "http://127.0.0.1:8000/docs",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        }]
      : []),
  ],
});
