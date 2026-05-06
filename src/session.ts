import { rm, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS } from "./types.js";

/**
 * Reset the AgentLens session by clearing the observation log and screenshots.
 * Safe to call even if no session exists.
 */
export async function resetSession(outputDir?: string): Promise<void> {
  const dir = outputDir ?? DEFAULTS.outputDir;

  const filesToRemove = ["latest.json", "latest.md", "latest.html"];
  for (const file of filesToRemove) {
    try {
      await rm(join(dir, file), { force: true });
    } catch {
      // File doesn't exist — fine
    }
  }

  // Clear screenshots directory
  const screenshotsDir = join(dir, "screenshots");
  try {
    await access(screenshotsDir);
    const files = await readdir(screenshotsDir);
    for (const file of files) {
      await rm(join(screenshotsDir, file), { force: true });
    }
  } catch {
    // Directory doesn't exist — fine
  }
}
