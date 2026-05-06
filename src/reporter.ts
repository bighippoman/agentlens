import { writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

interface FailureEntry {
  title: string;
  fullTitle: string;
  filePath: string;
  errorMessage: string;
  attachmentPaths: string[];
  tracePath: string | null;
  screenshotPath: string | null;
  duration: number;
  retries: number;
}

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  totalDuration: number;
}

/**
 * AgentLens Playwright Reporter
 *
 * Produces `.agentlens/failures.md` — a concise summary of test results
 * designed for AI agent consumption. Never inlines trace contents, screenshots,
 * DOM, or video — only references file paths.
 *
 * Usage in playwright.config.ts:
 * ```ts
 * reporter: [
 *   ['html'],
 *   ['agentlens/reporter'],
 * ],
 * ```
 */
class AgentLensReporter implements Reporter {
  private failures: FailureEntry[] = [];
  private stats: TestStats = {
    total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, totalDuration: 0,
  };
  private outputDir = ".agentlens";
  private rootDir = "";
  private startTime = Date.now();

  async onBegin(config: FullConfig, _suite: Suite): Promise<void> {
    this.rootDir = config.rootDir;
    this.startTime = Date.now();

    // Auto-reset session at the start of each test run
    try {
      const { resetSession } = await import("./session.js");
      await resetSession(this.outputDir);
    } catch {
      // Session module may not be available — skip silently
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.stats.total++;
    this.stats.totalDuration += result.duration;

    if (result.status === "skipped") {
      this.stats.skipped++;
      return;
    }
    if (result.status === "passed") {
      this.stats.passed++;
      return;
    }

    // Flaky = eventually passed after retries
    if (test.outcome() === "flaky") {
      this.stats.flaky++;
      return;
    }

    this.stats.failed++;

    const filePath = relative(this.rootDir, test.location.file);
    const fullTitle = test.titlePath().join(" > ");

    const errorMessage = result.errors
      .map((e) => {
        const msg = e.message ?? "";
        // Strip ANSI codes and truncate
        const clean = msg.replace(
          // eslint-disable-next-line no-control-regex
          /\u001b\[[0-9;]*m/g,
          ""
        );
        return clean.length > 500 ? clean.slice(0, 497) + "..." : clean;
      })
      .join("\n---\n");

    let tracePath: string | null = null;
    let screenshotPath: string | null = null;
    const attachmentPaths: string[] = [];

    for (const attachment of result.attachments) {
      const path = attachment.path;
      if (!path) continue;

      const relativePath = relative(this.rootDir, path);

      if (attachment.name === "trace") {
        tracePath = relativePath;
      } else if (
        attachment.name === "screenshot" ||
        attachment.contentType.startsWith("image/")
      ) {
        screenshotPath = relativePath;
      }

      attachmentPaths.push(relativePath);
    }

    this.failures.push({
      title: test.title,
      fullTitle,
      filePath,
      errorMessage,
      attachmentPaths,
      tracePath,
      screenshotPath,
      duration: result.duration,
      retries: test.retries,
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    const mdPath = join(this.outputDir, "failures.md");

    const wallTime = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const lines: string[] = [];

    lines.push("# AgentLens Test Report");
    lines.push("");

    // Summary stats
    lines.push("## Summary");
    lines.push("");
    lines.push(`| Metric | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total | ${this.stats.total} |`);
    lines.push(`| Passed | ${this.stats.passed} |`);
    lines.push(`| Failed | ${this.stats.failed} |`);
    lines.push(`| Skipped | ${this.stats.skipped} |`);
    if (this.stats.flaky > 0) {
      lines.push(`| Flaky | ${this.stats.flaky} |`);
    }
    lines.push(`| Duration | ${wallTime}s |`);
    lines.push("");

    if (this.failures.length === 0) {
      lines.push("All tests passed.");
      lines.push("");
      await writeFile(mdPath, lines.join("\n"), "utf-8");
      return;
    }

    // Failures
    lines.push(`## Failures (${this.failures.length})`);
    lines.push("");

    for (const failure of this.failures) {
      lines.push(`### ${failure.title}`);
      lines.push("");
      lines.push(`- **File:** \`${failure.filePath}\``);
      lines.push(`- **Full path:** ${failure.fullTitle}`);
      lines.push(`- **Duration:** ${(failure.duration / 1000).toFixed(1)}s`);
      if (failure.retries > 0) {
        lines.push(`- **Retries:** ${failure.retries}`);
      }
      lines.push("");
      lines.push("**Error:**");
      lines.push("```");
      lines.push(failure.errorMessage);
      lines.push("```");
      lines.push("");

      if (failure.screenshotPath) {
        lines.push(`**Screenshot:** \`${failure.screenshotPath}\``);
        lines.push("");
      }

      if (failure.tracePath) {
        lines.push(`**Trace:** \`${failure.tracePath}\``);
        lines.push(`View: \`npx playwright show-trace ${failure.tracePath}\``);
        lines.push("");
      }

      if (failure.attachmentPaths.length > 0) {
        lines.push("**Attachments:**");
        for (const p of failure.attachmentPaths) {
          lines.push(`- \`${p}\``);
        }
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }

    // Suggested next steps
    lines.push("## Suggested Next Steps");
    lines.push("");
    lines.push("1. Look at the screenshot for each failure to understand what the page looked like");
    lines.push("2. Read the error message for the assertion or timeout that failed");
    lines.push("3. If more context is needed, view the trace with `npx playwright show-trace <path>`");
    lines.push("4. Do **not** read trace/screenshot file contents directly — view them with appropriate tools");
    lines.push("");

    // Context avoided section
    lines.push("## Context Avoided");
    lines.push("");
    lines.push("The following were **not** inlined to preserve agent context:");
    lines.push("");
    lines.push("- Trace file contents");
    lines.push("- Screenshot image data");
    lines.push("- Video file contents");
    lines.push("- Full DOM snapshots");
    lines.push("");

    await writeFile(mdPath, lines.join("\n"), "utf-8");
  }
}

export default AgentLensReporter;
