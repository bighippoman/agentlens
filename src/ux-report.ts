import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLensOptions, ObservationLog, Observation } from "./types.js";
import { loadConfig, resolveOptions } from "./config.js";

/**
 * Generate a Markdown UX report from the observation log.
 */
export async function uxReport(options?: AgentLensOptions): Promise<string> {
  const fileConfig = await loadConfig();
  const opts = resolveOptions(options, fileConfig);
  const logPath = join(opts.outputDir, "latest.json");
  const mdPath = join(opts.outputDir, "latest.md");

  const raw = await readFile(logPath, "utf-8");
  const log: ObservationLog = JSON.parse(raw);

  const md = generateMarkdownReport(log);
  await writeFile(mdPath, md, "utf-8");

  return md;
}

/**
 * Generate a self-contained HTML report with inline base64 screenshots.
 */
export async function uxReportHtml(options?: AgentLensOptions): Promise<string> {
  const fileConfig = await loadConfig();
  const opts = resolveOptions(options, fileConfig);
  const logPath = join(opts.outputDir, "latest.json");
  const htmlPath = join(opts.outputDir, "latest.html");

  const raw = await readFile(logPath, "utf-8");
  const log: ObservationLog = JSON.parse(raw);

  const html = await generateHtmlReport(log);
  await writeFile(htmlPath, html, "utf-8");

  return html;
}

export function generateMarkdownReport(log: ObservationLog): string {
  const lines: string[] = [];

  lines.push("# AgentLens UX Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Session started: ${log.startedAt}`);
  lines.push(`Total observations: ${log.observations.length}`);
  lines.push("");

  // Journey steps with inline diffs
  lines.push("## Journey");
  lines.push("");
  for (const obs of log.observations) {
    lines.push(`### Step ${obs.step}: ${obs.label}`);
    lines.push("");
    lines.push(`- **URL:** ${obs.visibleState.url}`);
    lines.push(`- **Time:** ${obs.timestamp}`);
    if (obs.screenshotPath) {
      lines.push(`- **Screenshot:** \`${obs.screenshotPath}\``);
    }

    if (obs.diff) {
      const d = obs.diff;
      const changes: string[] = [];
      if (d.urlChanged) changes.push(`URL changed: ${d.oldUrl} → ${d.newUrl}`);
      if (d.titleChanged) changes.push("Page title changed");
      if (d.headingsAdded.length > 0) changes.push(`New headings: ${d.headingsAdded.join(", ")}`);
      if (d.headingsRemoved.length > 0) changes.push(`Removed headings: ${d.headingsRemoved.join(", ")}`);
      if (d.buttonsAdded.length > 0) changes.push(`New buttons: ${d.buttonsAdded.join(", ")}`);
      if (d.buttonsRemoved.length > 0) changes.push(`Removed buttons: ${d.buttonsRemoved.join(", ")}`);
      if (d.inputsAdded.length > 0) changes.push(`New inputs: ${d.inputsAdded.join(", ")}`);
      if (d.inputsRemoved.length > 0) changes.push(`Removed inputs: ${d.inputsRemoved.join(", ")}`);
      if (d.newConsoleErrors > 0) changes.push(`${d.newConsoleErrors} new console error(s)`);
      if (d.newFailedRequests > 0) changes.push(`${d.newFailedRequests} new failed request(s)`);

      if (changes.length > 0) {
        lines.push("- **Changes since previous step:**");
        for (const c of changes) lines.push(`  - ${c}`);
      } else {
        lines.push("- **Changes:** None (page unchanged)");
      }
    }
    lines.push("");
  }

  const current = log.observations[log.observations.length - 1];
  if (current) {
    const s = current.visibleState;

    lines.push("## Current State");
    lines.push("");
    lines.push(`- **URL:** ${s.url}`);
    lines.push(`- **Title:** ${s.title}`);
    lines.push(`- **Viewport:** ${s.viewportSize.width}x${s.viewportSize.height}`);
    lines.push("");

    // Performance metrics
    if (s.performance) {
      lines.push("### Performance");
      lines.push("");
      lines.push("| Metric | Value |");
      lines.push("|--------|-------|");
      if (s.performance.ttfb !== null) lines.push(`| TTFB | ${s.performance.ttfb}ms |`);
      if (s.performance.lcp !== null) lines.push(`| LCP | ${s.performance.lcp}ms |`);
      if (s.performance.cls !== null) lines.push(`| CLS | ${s.performance.cls} |`);
      if (s.performance.domContentLoaded !== null) lines.push(`| DOM Content Loaded | ${s.performance.domContentLoaded}ms |`);
      if (s.performance.load !== null) lines.push(`| Full Load | ${s.performance.load}ms |`);
      lines.push("");

      // Performance warnings
      if (s.performance.lcp !== null && s.performance.lcp > 2500) {
        lines.push(`> Warning: LCP is ${s.performance.lcp}ms (target: <2500ms). Page may feel slow.`);
      }
      if (s.performance.cls !== null && s.performance.cls > 0.1) {
        lines.push(`> Warning: CLS is ${s.performance.cls} (target: <0.1). Layout shifts detected.`);
      }
      if (s.performance.ttfb !== null && s.performance.ttfb > 800) {
        lines.push(`> Warning: TTFB is ${s.performance.ttfb}ms (target: <800ms). Server response slow.`);
      }
      lines.push("");
    }

    // Headings
    if (s.headings.length > 0) {
      lines.push("### Headings");
      lines.push("");
      for (const h of s.headings) {
        lines.push(`${"  ".repeat(h.level - 1)}- H${h.level}: ${h.text}`);
      }
      const levels = s.headings.map((h) => h.level);
      if (!levels.includes(1)) {
        lines.push("");
        lines.push("> Note: No H1 found. Consider adding a primary heading for accessibility.");
      }
      if (levels.some((l, i) => i > 0 && l > levels[i - 1]! + 1)) {
        lines.push("");
        lines.push("> Note: Heading level skip detected (e.g., H1 → H3). May confuse screen readers.");
      }
      lines.push("");
    }

    // Buttons
    if (s.buttons.length > 0) {
      lines.push("### Buttons / CTAs");
      lines.push("");
      for (const btn of s.buttons) {
        const disabled = btn.disabled ? " (disabled)" : "";
        const aria = btn.ariaLabel ? ` [aria: ${btn.ariaLabel}]` : "";
        const noText = !btn.text && !btn.ariaLabel ? " **(missing label!)**" : "";
        lines.push(`- ${btn.text || btn.ariaLabel || "(no text)"}${aria}${disabled}${noText}`);
      }
      const unlabeled = s.buttons.filter((b) => !b.text && !b.ariaLabel).length;
      if (unlabeled > 0) {
        lines.push("");
        lines.push(`> Warning: ${unlabeled} button(s) have no text or aria-label.`);
      }
      lines.push("");
    }

    // Links
    if (s.links.length > 0) {
      lines.push("### Links");
      lines.push("");
      for (const link of s.links.slice(0, 20)) {
        const aria = link.ariaLabel ? ` [aria: ${link.ariaLabel}]` : "";
        lines.push(`- [${link.text || "(no text)"}](${link.href})${aria}`);
      }
      if (s.links.length > 20) lines.push(`- ...and ${s.links.length - 20} more links`);
      lines.push("");
    }

    // Inputs
    if (s.inputs.length > 0) {
      lines.push("### Inputs");
      lines.push("");
      for (const input of s.inputs) {
        const label = input.label || input.placeholder || input.name || "(unlabeled)";
        const type = input.type ? `[${input.type}]` : "[input]";
        const val = input.value ? ` = "${input.value}"` : "";
        lines.push(`- ${type} ${label}${val}`);
      }
      const filled = s.inputs.filter((i) => i.value).length;
      const total = s.inputs.length;
      const unlabeled = s.inputs.filter((i) => !i.label && !i.placeholder && !i.ariaLabel).length;
      lines.push("");
      lines.push(`> Form: ${filled}/${total} fields filled (${Math.round((filled / total) * 100)}%).`);
      if (unlabeled > 0) lines.push(`> Warning: ${unlabeled} input(s) have no label, placeholder, or aria-label.`);
      lines.push("");
    }

    // Console errors (deduplicated with counts)
    if (s.consoleErrors.length > 0) {
      lines.push("### Console Errors");
      lines.push("");
      for (const err of s.consoleErrors) {
        const countSuffix = err.count > 1 ? ` (x${err.count})` : "";
        lines.push(`- \`${err.message}\`${countSuffix}`);
      }
      lines.push("");
    }

    // Failed requests
    if (s.failedRequests.length > 0) {
      lines.push("### Failed Network Requests");
      lines.push("");
      for (const req of s.failedRequests) {
        lines.push(`- ${req.method} ${req.url} → ${req.status}`);
      }
      lines.push("");
    }

    // Storage state
    if (s.storage) {
      lines.push("### Storage State");
      lines.push("");
      if (s.storage.cookies.length > 0) {
        lines.push(`**Cookies (${s.storage.cookies.length}):**`);
        for (const c of s.storage.cookies.slice(0, 15)) {
          const flags = [c.secure ? "secure" : "", c.httpOnly ? "httpOnly" : ""].filter(Boolean).join(", ");
          lines.push(`- \`${c.name}\` (${c.domain}${c.path})${flags ? ` [${flags}]` : ""}`);
        }
        if (s.storage.cookies.length > 15) lines.push(`- ...and ${s.storage.cookies.length - 15} more`);
        lines.push("");
      }
      if (s.storage.localStorageKeys.length > 0) {
        lines.push(`**localStorage keys:** ${s.storage.localStorageKeys.join(", ")}`);
        lines.push("");
      }
      if (s.storage.sessionStorageKeys.length > 0) {
        lines.push(`**sessionStorage keys:** ${s.storage.sessionStorageKeys.join(", ")}`);
        lines.push("");
      }
    }

    // Screenshots index
    lines.push("### Screenshots");
    lines.push("");
    for (const obs of log.observations) {
      if (obs.screenshotPath) {
        lines.push(`- Step ${obs.step} (${obs.label}): \`${obs.screenshotPath}\``);
      }
    }
    lines.push("");

    // UX Analysis
    lines.push("### UX Analysis");
    lines.push("");
    writeUXAnalysis(lines, log);
    lines.push("");
  }

  // Context avoided
  lines.push("## Context Avoided");
  lines.push("");
  lines.push("The following large artifacts were **not** included to preserve agent context:");
  lines.push("");
  lines.push("- Full DOM (`page.content()`) — never captured");
  lines.push("- Trace file contents — paths referenced only");
  lines.push("- Video file contents — paths referenced only");
  lines.push("- Full accessibility tree — scoped ARIA snapshots used instead");
  lines.push("");

  return lines.join("\n");
}

async function generateHtmlReport(log: ObservationLog): Promise<string> {
  const md = generateMarkdownReport(log);

  // Read screenshots and inline as base64
  const screenshotSections: string[] = [];
  for (const obs of log.observations) {
    if (obs.screenshotPath) {
      try {
        const data = await readFile(obs.screenshotPath);
        const base64 = data.toString("base64");
        screenshotSections.push(`
          <div class="screenshot">
            <h4>Step ${obs.step}: ${escapeHtml(obs.label)}</h4>
            <img src="data:image/png;base64,${base64}" alt="${escapeHtml(obs.label)}" />
          </div>
        `);
      } catch {
        screenshotSections.push(`
          <div class="screenshot">
            <h4>Step ${obs.step}: ${escapeHtml(obs.label)}</h4>
            <p><em>Screenshot not found: ${escapeHtml(obs.screenshotPath)}</em></p>
          </div>
        `);
      }
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentLens UX Report</title>
  <style>
    :root { --bg: #0d1117; --fg: #c9d1d9; --accent: #58a6ff; --border: #30363d; --card: #161b22; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--fg); max-width: 960px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
    h1, h2, h3, h4 { color: var(--accent); }
    pre { background: var(--card); padding: 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid var(--border); }
    code { background: var(--card); padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    .screenshot { margin: 1rem 0; }
    .screenshot img { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; }
    .markdown { white-space: pre-wrap; }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 0.5rem; text-align: left; border: 1px solid var(--border); }
    th { background: var(--card); }
    blockquote { border-left: 3px solid var(--accent); margin: 0.5rem 0; padding: 0.5rem 1rem; background: var(--card); }
  </style>
</head>
<body>
  <h1>AgentLens UX Report</h1>
  <p>Generated: ${new Date().toISOString()}</p>

  <h2>Screenshots</h2>
  ${screenshotSections.join("\n")}

  <h2>Full Report</h2>
  <pre class="markdown">${escapeHtml(md)}</pre>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeUXAnalysis(lines: string[], log: ObservationLog): void {
  const current = log.observations[log.observations.length - 1];
  if (!current) return;

  const s = current.visibleState;
  const interactiveCount = s.interactiveElements.length;
  const viewportVisible = s.interactiveElements.filter((e) => e.visible).length;
  const hasErrors = s.consoleErrors.length > 0;
  const hasFailedRequests = s.failedRequests.length > 0;

  if (interactiveCount === 0) {
    lines.push("- No interactive elements detected — page may be static or still loading.");
  } else {
    lines.push(`- ${viewportVisible} of ${interactiveCount} interactive elements visible in viewport.`);
    if (viewportVisible < interactiveCount) {
      lines.push(`- ${interactiveCount - viewportVisible} element(s) are below the fold.`);
    }
  }

  const totalErrors = s.consoleErrors.reduce((sum, e) => sum + e.count, 0);
  if (hasErrors) {
    lines.push(`- ${totalErrors} console error(s) across ${s.consoleErrors.length} unique message(s).`);
  }
  if (hasFailedRequests) {
    lines.push(`- ${s.failedRequests.length} failed request(s) — may indicate backend issues.`);
  }
  if (!hasErrors && !hasFailedRequests) {
    lines.push("- No errors or failed requests. Page appears healthy.");
  }

  if (log.observations.length > 1) {
    const urls = new Set(log.observations.map((o) => o.visibleState.url));
    lines.push(`- Journey covers ${urls.size} unique page(s) across ${log.observations.length} steps.`);

    const urlCounts = new Map<string, number>();
    for (const obs of log.observations) {
      const url = obs.visibleState.url;
      urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
    }
    const revisited = [...urlCounts.entries()].filter(([, count]) => count > 1);
    if (revisited.length > 0) {
      lines.push(`- Revisited pages: ${revisited.map(([url, count]) => `${url} (${count}x)`).join(", ")}`);
    }

    const totalNewErrors = log.observations
      .filter((o): o is Observation & { diff: NonNullable<Observation["diff"]> } => o.diff !== null)
      .reduce((sum, o) => sum + o.diff.newConsoleErrors, 0);
    if (totalNewErrors > 5) {
      lines.push(`- ${totalNewErrors} total console errors accumulated across the journey — investigate root cause.`);
    }
  }
}
