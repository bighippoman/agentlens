import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  use: {
    headless: true,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  timeout: 30000,
  retries: 0,
});
