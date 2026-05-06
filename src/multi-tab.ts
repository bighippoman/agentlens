import type { BrowserContext, Page } from "@playwright/test";
import type { AgentLensOptions, Observation } from "./types.js";
import { observe } from "./observe.js";

/**
 * Observe all open pages in a browser context.
 *
 * Returns one observation per open page/tab, labeled with the tab index.
 * Useful for flows that open new tabs or popups.
 */
export async function observeAllTabs(
  context: BrowserContext,
  label: string,
  options?: AgentLensOptions
): Promise<Observation[]> {
  const pages = context.pages();
  const observations: Observation[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const tabLabel = pages.length === 1
      ? label
      : `${label} [tab ${i + 1}/${pages.length}]`;
    const obs = await observe(page, tabLabel, options);
    observations.push(obs);
  }

  return observations;
}

/**
 * Wait for a new page to open in the context and return it.
 *
 * Useful for handling popups or links that open in new tabs.
 */
export async function waitForNewTab(
  context: BrowserContext,
  action: () => Promise<void>,
  options?: { timeout?: number }
): Promise<Page> {
  const timeout = options?.timeout ?? 5000;
  const [newPage] = await Promise.all([
    context.waitForEvent("page", { timeout }),
    action(),
  ]);
  await newPage.waitForLoadState("domcontentloaded");
  return newPage;
}
