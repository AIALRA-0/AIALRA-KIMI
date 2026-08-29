import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/readme",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:41784",
  },
  webServer: {
    command:
      "pnpm --filter @aialra-kimi/web build && pnpm --filter @aialra-kimi/web exec vite preview --host 127.0.0.1 --port 41784 --strictPort",
    url: "http://127.0.0.1:41784",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
