import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentLensOptions } from "./types.js";
import { DEFAULTS } from "./types.js";

let cachedConfig: AgentLensOptions | null = null;
let configLoaded = false;

const CONFIG_FILENAMES = [
  "agentlens.config.ts",
  "agentlens.config.js",
  "agentlens.config.mjs",
];

/**
 * Load the agentlens config file from the current working directory.
 * Tries agentlens.config.ts, .js, .mjs in order.
 * Returns DEFAULTS if no config file is found.
 * Caches the result — safe to call multiple times.
 */
export async function loadConfig(): Promise<AgentLensOptions> {
  if (configLoaded) return cachedConfig ?? {};
  configLoaded = true;

  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(process.cwd(), filename);
    try {
      await access(configPath);
      // Dynamic import for both TS (via tsx/ts-node) and JS files
      const fileUrl = pathToFileURL(configPath).href;
      const mod = await import(fileUrl);
      const config = mod.default ?? mod;
      if (config && typeof config === "object") {
        cachedConfig = config as AgentLensOptions;
        return cachedConfig;
      }
    } catch {
      // File doesn't exist or can't be imported — try next
    }
  }

  return {};
}

/**
 * Merge inline options with loaded config and defaults.
 * Priority: inline options > config file > defaults.
 */
export function resolveOptions(
  inline?: AgentLensOptions,
  fileConfig?: AgentLensOptions
): Required<AgentLensOptions> {
  return {
    outputDir: inline?.outputDir ?? fileConfig?.outputDir ?? DEFAULTS.outputDir,
    maxElements: inline?.maxElements ?? fileConfig?.maxElements ?? DEFAULTS.maxElements,
    maxTextLength: inline?.maxTextLength ?? fileConfig?.maxTextLength ?? DEFAULTS.maxTextLength,
    includeAria: inline?.includeAria ?? fileConfig?.includeAria ?? DEFAULTS.includeAria,
    ariaDepth: inline?.ariaDepth ?? fileConfig?.ariaDepth ?? DEFAULTS.ariaDepth,
    fullPage: inline?.fullPage ?? fileConfig?.fullPage ?? DEFAULTS.fullPage,
    actionTimeout: inline?.actionTimeout ?? fileConfig?.actionTimeout ?? DEFAULTS.actionTimeout,
    capturePerformance: inline?.capturePerformance ?? fileConfig?.capturePerformance ?? DEFAULTS.capturePerformance,
    captureStorage: inline?.captureStorage ?? fileConfig?.captureStorage ?? DEFAULTS.captureStorage,
  };
}

/**
 * Reset the cached config. Useful for testing.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
  configLoaded = false;
}
