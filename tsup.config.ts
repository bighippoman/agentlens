import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      reporter: "src/reporter.ts",
      fixture: "src/fixture.ts",
      agent: "src/agent/index.ts",
      browser: "src/browser/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    external: ["@playwright/test", "playwright", "playwright-core"],
  },
  {
    entry: {
      cli: "src/cli.ts",
    },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    splitting: false,
    external: ["@playwright/test", "playwright", "playwright-core"],
  },
]);
