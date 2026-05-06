import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentLensOptions, Observation, VisibleState } from "./types.js";
import { loadConfig, resolveOptions } from "./config.js";
import {
  ensureDir,
  readObservationLog,
  slugify,
  truncate,
  writeObservationLog,
} from "./utils.js";
import { getVisibleState } from "./visible-state.js";
import { generateMarkdownReport } from "./ux-report.js";

const MAX_ARIA_LENGTH = 5000;

/**
 * Observe the current state of a page.
 *
 * Takes a viewport screenshot, collects visible state, optionally captures
 * a size-capped ARIA snapshot, computes a diff from the previous observation,
 * and appends everything to the observation log.
 */
export async function observe(
  page: Page,
  label: string,
  options?: AgentLensOptions
): Promise<Observation> {
  const fileConfig = await loadConfig();
  const opts = resolveOptions(options, fileConfig);

  const screenshotsDir = join(opts.outputDir, "screenshots");
  await ensureDir(screenshotsDir);

  const log = await readObservationLog(opts.outputDir);
  const step = log.observations.length + 1;
  const prevState = log.observations.length > 0
    ? log.observations[log.observations.length - 1]!.visibleState
    : null;

  // Screenshot
  const slug = slugify(label);
  const screenshotFilename = `${String(step).padStart(3, "0")}-${slug}.png`;
  const screenshotPath = join(screenshotsDir, screenshotFilename);
  await page.screenshot({ path: screenshotPath, fullPage: opts.fullPage });

  // Visible state (pass resolved opts)
  const visibleState = await getVisibleState(page, opts);

  // ARIA snapshot (optional, size-capped)
  let ariaSnapshot: string | null = null;
  if (opts.includeAria) {
    try {
      const raw = await page.evaluate((depth: number) => {
        function walk(el: Element, d: number): string {
          if (d > depth) return "";
          const role = el.getAttribute("role") || el.tagName.toLowerCase();
          const lbl =
            el.getAttribute("aria-label") ||
            (el as HTMLElement).innerText?.slice(0, 80) ||
            "";
          const indent = "  ".repeat(d);
          let result = `${indent}- ${role}`;
          if (lbl) result += `: "${lbl.trim()}"`;
          const state: string[] = [];
          if (el.getAttribute("aria-expanded")) state.push(`expanded=${el.getAttribute("aria-expanded")}`);
          if (el.getAttribute("aria-checked")) state.push(`checked=${el.getAttribute("aria-checked")}`);
          if (el.getAttribute("aria-disabled") === "true") state.push("disabled");
          if (el.getAttribute("aria-selected") === "true") state.push("selected");
          if (state.length > 0) result += ` [${state.join(", ")}]`;
          result += "\n";
          for (const child of el.children) {
            const childResult = walk(child, d + 1);
            if (result.length + childResult.length > 6000) {
              result += `${indent}  ... (truncated)\n`;
              break;
            }
            result += childResult;
          }
          return result;
        }
        return walk(document.body, 0);
      }, opts.ariaDepth);
      ariaSnapshot = truncate(raw, MAX_ARIA_LENGTH);
    } catch {
      ariaSnapshot = null;
    }
  }

  const diff = prevState ? computeStateDiff(prevState, visibleState) : null;

  const observation: Observation = {
    step,
    label,
    timestamp: new Date().toISOString(),
    screenshotPath,
    visibleState,
    ariaSnapshot,
    diff,
  };

  log.observations.push(observation);
  await writeObservationLog(opts.outputDir, log);

  const md = generateMarkdownReport(log);
  await writeFile(join(opts.outputDir, "latest.md"), md, "utf-8");

  return observation;
}

/**
 * Observe a page at multiple viewport sizes for responsive testing.
 *
 * Returns one observation per viewport width. Restores the original viewport after.
 */
export async function observeResponsive(
  page: Page,
  label: string,
  viewportWidths: number[],
  options?: AgentLensOptions
): Promise<Observation[]> {
  const original = page.viewportSize();
  const observations: Observation[] = [];

  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: original?.height ?? 720 });
    const obs = await observe(page, `${label} @${width}px`, options);
    observations.push(obs);
  }

  // Restore original viewport
  if (original) {
    await page.setViewportSize(original);
  }

  return observations;
}

function computeStateDiff(prev: VisibleState, curr: VisibleState) {
  const prevHeadings = new Set(prev.headings.map((h) => `H${h.level}: ${h.text}`));
  const currHeadings = new Set(curr.headings.map((h) => `H${h.level}: ${h.text}`));

  const prevButtons = new Set(prev.buttons.map((b) => b.text || b.ariaLabel || ""));
  const currButtons = new Set(curr.buttons.map((b) => b.text || b.ariaLabel || ""));

  const prevInputs = new Set(
    prev.inputs.map((i) => i.label || i.placeholder || i.name || i.type || "")
  );
  const currInputs = new Set(
    curr.inputs.map((i) => i.label || i.placeholder || i.name || i.type || "")
  );

  return {
    urlChanged: prev.url !== curr.url,
    titleChanged: prev.title !== curr.title,
    ...(prev.url !== curr.url ? { oldUrl: prev.url, newUrl: curr.url } : {}),
    headingsAdded: [...currHeadings].filter((h) => !prevHeadings.has(h)),
    headingsRemoved: [...prevHeadings].filter((h) => !currHeadings.has(h)),
    buttonsAdded: [...currButtons].filter((b) => !prevButtons.has(b)),
    buttonsRemoved: [...prevButtons].filter((b) => !currButtons.has(b)),
    inputsAdded: [...currInputs].filter((i) => !prevInputs.has(i)),
    inputsRemoved: [...prevInputs].filter((i) => !currInputs.has(i)),
    newConsoleErrors: curr.consoleErrors.reduce((sum, e) => sum + e.count, 0),
    newFailedRequests: curr.failedRequests.length,
  };
}
