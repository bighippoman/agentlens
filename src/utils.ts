import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ObservationLog } from "./types.js";

/**
 * Escape a string for safe interpolation into CSS selectors.
 * Prevents selector injection from DOM-sourced values.
 */
export function cssEscape(value: string): string {
  return value.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "\\$&");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readObservationLog(
  outputDir: string
): Promise<ObservationLog> {
  const logPath = join(outputDir, "latest.json");
  try {
    const raw = await readFile(logPath, "utf-8");
    return JSON.parse(raw) as ObservationLog;
  } catch {
    return { startedAt: new Date().toISOString(), observations: [] };
  }
}

export async function writeObservationLog(
  outputDir: string,
  log: ObservationLog
): Promise<void> {
  const logPath = join(outputDir, "latest.json");
  await ensureDir(outputDir);
  await writeFile(logPath, JSON.stringify(log, null, 2), "utf-8");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Levenshtein edit distance between two strings.
 * Used by fuzzyMatch to handle typos ("Sbumit" → "Submit").
 */
export function levenshtein(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Use single-row optimization: O(min(m,n)) space
  const shorter = aLen < bLen ? a : b;
  const longer = aLen < bLen ? b : a;
  const sLen = shorter.length;
  const lLen = longer.length;

  let prev = new Array<number>(sLen + 1);
  let curr = new Array<number>(sLen + 1);

  for (let i = 0; i <= sLen; i++) prev[i] = i;

  for (let j = 1; j <= lLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= sLen; i++) {
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1]! + 1,      // insertion
        prev[i]! + 1,           // deletion
        prev[i - 1]! + cost     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[sLen]!;
}

/**
 * Fuzzy match score between two strings (0 = no match, 1 = exact match).
 *
 * Scoring tiers:
 * - 1.0: exact match
 * - 0.95: case-insensitive exact match
 * - 0.9: one string contains the other
 * - 0.5–0.85: edit distance within tolerance (handles typos)
 * - 0.3–0.7: word overlap scoring
 * - 0: no useful match
 */
export function fuzzyMatch(needle: string, haystack: string): number {
  if (!needle || !haystack) return 0;

  const n = needle.toLowerCase().trim();
  const h = haystack.toLowerCase().trim();

  if (!n || !h) return 0;

  // Exact match (case-insensitive)
  if (h === n) return 1;

  // Containment — haystack contains needle or vice versa
  if (h.includes(n)) return 0.9;
  if (n.includes(h)) return 0.85;

  // Edit distance scoring — good for typos
  const dist = levenshtein(n, h);
  const maxLen = Math.max(n.length, h.length);
  const similarity = 1 - dist / maxLen;

  // Accept edit distance matches when > 60% similar
  if (similarity > 0.6) {
    // Scale 0.6–1.0 similarity into 0.5–0.85 score range
    return 0.5 + (similarity - 0.6) * 0.875;
  }

  // Word overlap scoring — "Sign In" vs "Sign In Button"
  const needleWords = n.split(/\s+/);
  const haystackWords = h.split(/\s+/);

  if (needleWords.length > 1 || haystackWords.length > 1) {
    let matched = 0;
    for (const nw of needleWords) {
      if (nw.length < 2) continue;
      for (const hw of haystackWords) {
        if (hw.length < 2 && hw !== nw) continue;
        // Word-level: exact match, containment, or close edit distance
        if (hw === nw) {
          matched++;
          break;
        }
        if (hw.includes(nw) || nw.includes(hw)) {
          matched += 0.8;
          break;
        }
        const wordDist = levenshtein(nw, hw);
        const wordMaxLen = Math.max(nw.length, hw.length);
        if (wordDist <= Math.ceil(wordMaxLen * 0.3)) {
          matched += 0.6;
          break;
        }
      }
    }

    const totalWords = needleWords.filter((w) => w.length >= 2).length || 1;
    const wordScore = matched / totalWords;
    if (wordScore > 0) return Math.min(0.8, wordScore * 0.7);
  }

  return 0;
}
