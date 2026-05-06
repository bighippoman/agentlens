import type { Page } from "@playwright/test";
import type { ContextBudget, PageDelta, PageDigest } from "./types.js";
import { getPageDigest } from "./digest.js";

const previousDigests = new WeakMap<Page, PageDigest>();

/**
 * Get what changed since the last digest for this page.
 *
 * If no previous digest exists, returns the full current digest as "all added".
 * The delta is designed to be tiny — typically under 100 tokens when nothing
 * meaningful changed.
 */
export async function getPageDelta(
  page: Page,
  budget?: Partial<ContextBudget>
): Promise<PageDelta> {
  const current = await getPageDigest(page, budget);
  const previous = previousDigests.get(page);
  previousDigests.set(page, current);

  if (!previous) {
    return {
      navigated: false,
      added: current.components.map((c) => ({
        type: c.type,
        name: c.name,
        summary: c.summary,
      })),
      removed: [],
      changed: [],
      newBlockers: current.status.blockers,
      resolvedBlockers: [],
      newErrors: current.status.consoleErrors,
      unchanged: false,
      text: `[initial] ${current.text}`,
      tokens: current.tokens + 5,
    };
  }

  const navigated = previous.url !== current.url;

  // Component diff
  const prevByKey = new Map(previous.components.map((c) => [`${c.type}:${c.name}`, c]));
  const currByKey = new Map(current.components.map((c) => [`${c.type}:${c.name}`, c]));

  const added = current.components
    .filter((c) => !prevByKey.has(`${c.type}:${c.name}`))
    .map((c) => ({ type: c.type, name: c.name, summary: c.summary }));

  const removed = previous.components
    .filter((c) => !currByKey.has(`${c.type}:${c.name}`))
    .map((c) => ({ type: c.type, name: c.name }));

  // Detect changes in shared components
  const changed: { name: string; change: string }[] = [];
  for (const [key, prevComp] of prevByKey) {
    const currComp = currByKey.get(key);
    if (!currComp) continue;
    if (prevComp.summary !== currComp.summary) {
      changed.push({ name: currComp.name, change: currComp.summary });
    }
  }

  // Blocker diff
  const prevBlockerKeys = new Set(previous.status.blockers.map((b) => `${b.type}:${b.selector}`));
  const currBlockerKeys = new Set(current.status.blockers.map((b) => `${b.type}:${b.selector}`));

  const newBlockers = current.status.blockers.filter(
    (b) => !prevBlockerKeys.has(`${b.type}:${b.selector}`)
  );
  const resolvedBlockers = previous.status.blockers
    .filter((b) => !currBlockerKeys.has(`${b.type}:${b.selector}`))
    .map((b) => b.description);

  const newErrors = Math.max(0, current.status.consoleErrors - previous.status.consoleErrors);

  const unchanged =
    !navigated &&
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    newBlockers.length === 0 &&
    resolvedBlockers.length === 0 &&
    newErrors === 0;

  const text = renderDelta(
    navigated, current.url, added, removed, changed,
    newBlockers, resolvedBlockers, newErrors, unchanged, current.suggestedAction
  );

  return {
    navigated,
    ...(navigated ? { newUrl: current.url } : {}),
    added,
    removed,
    changed,
    newBlockers,
    resolvedBlockers,
    newErrors,
    unchanged,
    text,
    tokens: estimateTokens(text),
  };
}

/**
 * Store a digest as the baseline for future delta comparisons.
 */
export function setBaseline(page: Page, digest: PageDigest): void {
  previousDigests.set(page, digest);
}

/**
 * Clear the baseline so the next delta returns the full state.
 */
export function clearBaseline(page: Page): void {
  previousDigests.delete(page);
}

function renderDelta(
  navigated: boolean,
  url: string,
  added: { type: string; name: string; summary: string }[],
  removed: { type: string; name: string }[],
  changed: { name: string; change: string }[],
  newBlockers: { type: string; description: string }[],
  resolvedBlockers: string[],
  newErrors: number,
  unchanged: boolean,
  suggestedAction: string | null
): string {
  if (unchanged) return "[no change]";

  const lines: string[] = [];

  if (navigated) lines.push(`Navigated → ${url}`);
  for (const b of newBlockers) lines.push(`! ${b.type} appeared: ${b.description}`);
  for (const b of resolvedBlockers) lines.push(`✓ dismissed: ${b}`);
  for (const a of added) lines.push(`+ [${a.type}] ${a.name}: ${a.summary}`);
  for (const r of removed) lines.push(`- [${r.type}] ${r.name}`);
  for (const c of changed) lines.push(`~ ${c.name}: ${c.change}`);
  if (newErrors > 0) lines.push(`! ${newErrors} new error(s)`);
  if (suggestedAction) lines.push(`Suggested: ${suggestedAction}`);

  return lines.join("\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
