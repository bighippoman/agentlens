import { test as base, type Page } from "@playwright/test";
import type { AgentLensOptions, ActionResult, Observation, VisibleState } from "./types.js";
import { observe, observeResponsive } from "./observe.js";
import { getVisibleState } from "./visible-state.js";
import { act } from "./act.js";
import { uxReport, uxReportHtml } from "./ux-report.js";
import { resetSession } from "./session.js";
import { matchAgentSnapshot, updateAgentSnapshot } from "./snapshot.js";

export interface AgentLens {
  /** Take a viewport screenshot, collect visible state, and log an observation. */
  observe: (label: string, options?: AgentLensOptions) => Promise<Observation>;
  /** Observe at multiple viewport widths for responsive testing. */
  observeResponsive: (label: string, viewportWidths: number[], options?: AgentLensOptions) => Promise<Observation[]>;
  /** Collect the visible state of the page without screenshots. */
  getVisibleState: (options?: AgentLensOptions) => Promise<VisibleState>;
  /** Execute a deterministic action using a natural-language instruction. */
  act: (instruction: string, options?: AgentLensOptions) => Promise<ActionResult>;
  /** Generate a Markdown UX report from the observation log. */
  uxReport: (options?: AgentLensOptions) => Promise<string>;
  /** Generate a self-contained HTML report with inline screenshots. */
  uxReportHtml: (options?: AgentLensOptions) => Promise<string>;
  /** Reset the observation session (clear log, screenshots, reports). */
  resetSession: (outputDir?: string) => Promise<void>;
  /** Compare current visible state against a saved snapshot. */
  matchSnapshot: (snapshotPath: string, options?: AgentLensOptions) => Promise<{ match: boolean; created?: boolean; diff?: string }>;
  /** Update a snapshot file with the current visible state. */
  updateSnapshot: (snapshotPath: string, options?: AgentLensOptions) => Promise<void>;
  /** The underlying Playwright page. */
  page: Page;
}

/**
 * Extended Playwright test with AgentLens fixture.
 *
 * Usage:
 * ```ts
 * import { test, expect } from "agentlens/fixture";
 *
 * test("checkout flow", async ({ lens }) => {
 *   await lens.page.goto("/");
 *   await lens.observe("Homepage loaded");
 *   await lens.act("click Sign In");
 *   await lens.observe("Sign in page");
 *   await lens.uxReport();
 * });
 * ```
 */
export const test = base.extend<{ lens: AgentLens }>({
  lens: async ({ page }, use) => {
    const lens: AgentLens = {
      observe: (label, options) => observe(page, label, options),
      observeResponsive: (label, widths, options) => observeResponsive(page, label, widths, options),
      getVisibleState: (options) => getVisibleState(page, options),
      act: (instruction, options) => act(page, instruction, options),
      uxReport: (options) => uxReport(options),
      uxReportHtml: (options) => uxReportHtml(options),
      resetSession: (outputDir) => resetSession(outputDir),
      matchSnapshot: async (snapshotPath, options) => {
        const state = await getVisibleState(page, options);
        return matchAgentSnapshot(state, snapshotPath);
      },
      updateSnapshot: async (snapshotPath, options) => {
        const state = await getVisibleState(page, options);
        await updateAgentSnapshot(state, snapshotPath);
      },
      page,
    };
    await use(lens);
  },
});

export { expect } from "@playwright/test";
