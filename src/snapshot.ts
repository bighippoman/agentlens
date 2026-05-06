import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { VisibleState } from "./types.js";

/**
 * Normalize a VisibleState for snapshot comparison.
 * Strips volatile fields (timestamps, exact positions) and sorts collections
 * for deterministic comparison.
 */
export function normalizeForSnapshot(state: VisibleState): Record<string, unknown> {
  return {
    url: state.url,
    title: state.title,
    headings: state.headings.map((h) => `H${h.level}: ${h.text}`).sort(),
    buttons: state.buttons
      .map((b) => ({
        text: b.text,
        ariaLabel: b.ariaLabel,
        disabled: b.disabled,
      }))
      .sort((a, b) => (a.text || "").localeCompare(b.text || "")),
    links: state.links
      .map((l) => ({
        text: l.text,
        href: l.href,
      }))
      .sort((a, b) => (a.text || "").localeCompare(b.text || "")),
    inputs: state.inputs
      .map((i) => ({
        type: i.type,
        label: i.label,
        placeholder: i.placeholder,
        name: i.name,
      }))
      .sort((a, b) => (a.label || a.name || "").localeCompare(b.label || b.name || "")),
    interactiveElementCount: state.interactiveElements.length,
    consoleErrorCount: state.consoleErrors.reduce((sum, e) => sum + e.count, 0),
    failedRequestCount: state.failedRequests.length,
  };
}

/**
 * Compare a VisibleState against a saved snapshot.
 *
 * - If the snapshot file doesn't exist, creates it and returns { match: true, created: true }
 * - If it matches, returns { match: true }
 * - If it differs, returns { match: false, diff } with the specific differences
 */
export async function matchAgentSnapshot(
  state: VisibleState,
  snapshotPath: string
): Promise<{ match: boolean; created?: boolean; diff?: string }> {
  const normalized = normalizeForSnapshot(state);
  const serialized = JSON.stringify(normalized, null, 2);

  try {
    const existing = await readFile(snapshotPath, "utf-8");
    if (existing === serialized) {
      return { match: true };
    }

    // Compute diff
    const existingParsed = JSON.parse(existing) as Record<string, unknown>;
    const diffs: string[] = [];
    for (const key of new Set([...Object.keys(existingParsed), ...Object.keys(normalized)])) {
      const a = JSON.stringify(existingParsed[key]);
      const b = JSON.stringify(normalized[key]);
      if (a !== b) {
        diffs.push(`  ${key}:\n    expected: ${a}\n    received: ${b}`);
      }
    }

    return { match: false, diff: diffs.join("\n") };
  } catch {
    // Snapshot doesn't exist — create it
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, serialized, "utf-8");
    return { match: true, created: true };
  }
}

/**
 * Update a snapshot file with the current state.
 */
export async function updateAgentSnapshot(
  state: VisibleState,
  snapshotPath: string
): Promise<void> {
  const normalized = normalizeForSnapshot(state);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(normalized, null, 2), "utf-8");
}
