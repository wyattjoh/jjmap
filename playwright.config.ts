import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/web/e2e",
  testMatch: "**/*.pw.ts",
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: ".scratch/web-test-results",
  reporter: "list",
  use: {
    channel: "chrome",
    headless: true,
    viewport: { width: 1166, height: 692 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
