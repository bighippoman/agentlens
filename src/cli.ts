import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

const AGENTLENS_DIR = ".agentlens";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = args.slice(1);

  switch (command) {
    case "init":
      await initCommand();
      break;
    case "summarize":
      await summarizeCommand();
      break;
    case "doctor":
      await doctorCommand(flags.includes("--fix"));
      break;
    case "clean":
      await cleanCommand();
      break;
    case "diff":
      await diffCommand(flags[0], flags[1]);
      break;
    case "ci":
      await ciCommand();
      break;
    case "install-browser":
      await installBrowserCommand();
      break;
    case "browser-status":
      await browserStatusCommand();
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
agentlens - Zero-dependency AI web inspector

Commands:
  init              Scaffold config and example test
  install-browser   Download Chromium (if no system Chrome found)
  browser-status    Show browser detection status
  summarize         Regenerate latest.md from latest.json
  doctor            Check test config for recommended settings
  doctor --fix      Auto-patch test config
  clean             Clear observation log, screenshots, and reports
  diff [a] [b]      Compare two observation logs
  ci                Generate a GitHub Actions workflow

Options:
  --help, -h     Show this help message
`);
}

async function initCommand(): Promise<void> {
  console.log("Initializing agentlens...\n");

  const configContent = `import type { AgentLensOptions } from "agentlens-ai";

const config: AgentLensOptions = {
  outputDir: ".agentlens",
  maxElements: 30,
  maxTextLength: 2000,
  includeAria: false,
  ariaDepth: 3,
  fullPage: false,
  actionTimeout: 5000,
  capturePerformance: false,
  captureStorage: false,
};

export default config;
`;
  await writeFileIfNotExists("agentlens.config.ts", configContent);

  await mkdir("tests/ux", { recursive: true });
  const specContent = `import { test } from "agentlens/fixture";

test("homepage UX walkthrough", async ({ lens }) => {
  await lens.page.goto("/");

  // Observe the initial state
  await lens.observe("Homepage loaded");

  // Example: click the primary call-to-action
  // await lens.act("click primary CTA");
  // await lens.observe("After CTA click");

  // Example: fill a form field
  // await lens.act("fill Email with user@test.com");

  // Example: select from dropdown
  // await lens.act("select United States in Country");

  // Generate the UX report
  await lens.uxReport();
});
`;
  await writeFileIfNotExists("tests/ux/homepage.ux.spec.ts", specContent);

  await mkdir(AGENTLENS_DIR, { recursive: true });
  const briefContent = `# AgentLens Agent Brief

## What is this?

AgentLens gives you (the AI agent) a structured way to inspect web pages
without burning your context window on full DOM dumps, traces, or video.

## How to use

1. **observe(page, label)** — take a viewport screenshot + collect visible state
2. **act(page, instruction)** — click buttons, fill inputs using fuzzy text matching
3. **uxReport()** — generate a Markdown summary of the journey so far

## Supported actions

- \`click [text]\` — fuzzy-match click
- \`click primary CTA\` — largest button above the fold
- \`fill [field] with [value]\` — fill an input
- \`type [field] with [value]\` — type character by character
- \`select [option] in [field]\` — select from dropdown
- \`check [label]\` / \`uncheck [label]\` — checkbox control
- \`hover [text]\` — hover for tooltips/menus
- \`press [key]\` — keyboard key (Enter, Escape, Tab)

## Key files

- \`.agentlens/latest.json\` — structured observation log
- \`.agentlens/latest.md\` — human/agent-readable Markdown report
- \`.agentlens/latest.html\` — HTML report with inline screenshots
- \`.agentlens/screenshots/\` — viewport screenshots by step
- \`.agentlens/failures.md\` — test failure summaries (from reporter)

## Rules

- Screenshots are your primary signal — look at them first
- The visible-state summary gives you structured data about what's on screen
- Use ARIA snapshots only when accessibility details matter
- Never ask for \`page.content()\` — it dumps the entire DOM into context
- Never inline trace or video contents
`;
  await writeFileIfNotExists(join(AGENTLENS_DIR, "agent-brief.md"), briefContent);

  // Create .gitignore for the output directory
  const gitignoreContent = `# Auto-generated files — regenerated on each run
latest.json
latest.md
latest.html
screenshots/
failures.md
`;
  await writeFileIfNotExists(join(AGENTLENS_DIR, ".gitignore"), gitignoreContent);

  console.log("Done! Created:");
  console.log("  - agentlens.config.ts");
  console.log("  - tests/ux/homepage.ux.spec.ts");
  console.log("  - .agentlens/agent-brief.md");
  console.log("  - .agentlens/.gitignore");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Run `agentlens doctor --fix` to configure your Playwright config");
  console.log("  2. Customize tests/ux/homepage.ux.spec.ts");
  console.log("  3. Run your tests with `npx playwright test`");
}

async function cleanCommand(): Promise<void> {
  const { resetSession } = await import("./session.js");
  await resetSession(AGENTLENS_DIR);
  console.log("Cleaned .agentlens/ — observation log, screenshots, and reports cleared.");
}

async function summarizeCommand(): Promise<void> {
  const logPath = join(AGENTLENS_DIR, "latest.json");
  try {
    await access(logPath);
  } catch {
    console.error(`No observation log found at ${logPath}. Run some observations first.`);
    process.exit(1);
  }

  const { uxReport } = await import("./ux-report.js");
  const md = await uxReport({ outputDir: AGENTLENS_DIR });
  console.log("Generated .agentlens/latest.md");
  console.log("");
  console.log(md);
}

async function diffCommand(pathA?: string, pathB?: string): Promise<void> {
  const a = pathA ?? join(AGENTLENS_DIR, "latest.json");

  if (!pathB) {
    console.error("Usage: agentlens diff <log-a.json> <log-b.json>");
    console.error("       agentlens diff <other-log.json>  (compares against latest.json)");
    // If only one arg, compare it against latest
    if (pathA) {
      const bPath = join(AGENTLENS_DIR, "latest.json");
      await runDiff(pathA, bPath);
      return;
    }
    process.exit(1);
  }

  await runDiff(a, pathB);
}

async function runDiff(pathA: string, pathB: string): Promise<void> {
  type Log = { observations: Array<{ step: number; label: string; visibleState: { url: string; title: string; headings: Array<{ level: number; text: string }>; buttons: Array<{ text: string }>; inputs: Array<{ label: string | null; name: string | null }> } }> };

  let logA: Log;
  let logB: Log;
  try {
    logA = JSON.parse(await readFile(pathA, "utf-8")) as Log;
  } catch {
    console.error(`Cannot read ${pathA}`);
    process.exit(1);
    return;
  }
  try {
    logB = JSON.parse(await readFile(pathB, "utf-8")) as Log;
  } catch {
    console.error(`Cannot read ${pathB}`);
    process.exit(1);
    return;
  }

  console.log(`Comparing:`);
  console.log(`  A: ${pathA} (${logA.observations.length} observations)`);
  console.log(`  B: ${pathB} (${logB.observations.length} observations)`);
  console.log("");

  const stepsA = logA.observations.length;
  const stepsB = logB.observations.length;
  if (stepsA !== stepsB) {
    console.log(`Step count: ${stepsA} → ${stepsB} (${stepsB > stepsA ? "+" : ""}${stepsB - stepsA})`);
  }

  const maxSteps = Math.max(stepsA, stepsB);
  for (let i = 0; i < maxSteps; i++) {
    const obsA = logA.observations[i];
    const obsB = logB.observations[i];

    if (!obsA) {
      console.log(`Step ${i + 1}: NEW — ${obsB!.label} (${obsB!.visibleState.url})`);
      continue;
    }
    if (!obsB) {
      console.log(`Step ${i + 1}: REMOVED — was ${obsA.label} (${obsA.visibleState.url})`);
      continue;
    }

    const changes: string[] = [];
    if (obsA.visibleState.url !== obsB.visibleState.url) {
      changes.push(`URL: ${obsA.visibleState.url} → ${obsB.visibleState.url}`);
    }
    if (obsA.visibleState.title !== obsB.visibleState.title) {
      changes.push(`Title: "${obsA.visibleState.title}" → "${obsB.visibleState.title}"`);
    }

    const hA = new Set(obsA.visibleState.headings.map((h) => `H${h.level}:${h.text}`));
    const hB = new Set(obsB.visibleState.headings.map((h) => `H${h.level}:${h.text}`));
    const headingsAdded = [...hB].filter((h) => !hA.has(h));
    const headingsRemoved = [...hA].filter((h) => !hB.has(h));
    if (headingsAdded.length) changes.push(`+headings: ${headingsAdded.join(", ")}`);
    if (headingsRemoved.length) changes.push(`-headings: ${headingsRemoved.join(", ")}`);

    const bA = obsA.visibleState.buttons.length;
    const bB = obsB.visibleState.buttons.length;
    if (bA !== bB) changes.push(`Buttons: ${bA} → ${bB}`);

    const iA = obsA.visibleState.inputs.length;
    const iB = obsB.visibleState.inputs.length;
    if (iA !== iB) changes.push(`Inputs: ${iA} → ${iB}`);

    if (changes.length > 0) {
      console.log(`Step ${i + 1} (${obsB.label}):`);
      for (const c of changes) console.log(`  ${c}`);
    }
  }

  if (maxSteps === 0) {
    console.log("Both logs are empty.");
  }
}

async function doctorCommand(fix: boolean): Promise<void> {
  console.log(`Checking playwright.config.ts...${fix ? " (--fix mode)" : ""}\n`);

  let configContent: string;
  let configPath = "playwright.config.ts";

  try {
    configContent = await readFile(configPath, "utf-8");
  } catch {
    try {
      configPath = "playwright.config.js";
      configContent = await readFile(configPath, "utf-8");
    } catch {
      console.error("No playwright.config.ts or playwright.config.js found in current directory.");
      process.exit(1);
      return;
    }
  }

  console.log(`Found: ${configPath}\n`);

  interface Check {
    name: string;
    ok: boolean;
    suggestion: string;
    patch: (() => string) | null;
  }

  const checks: Check[] = [];

  // Check reporter
  const hasReporter = configContent.includes("agentlens/reporter");
  checks.push({
    name: "AgentLens reporter",
    ok: hasReporter,
    suggestion: `Add reporter: [["agentlens/reporter"]]`,
    patch: hasReporter ? null : () => {
      // Find existing reporter array or use block
      const reporterMatch = configContent.match(/(reporter\s*:\s*\[)([\s\S]*?)(\])/);
      if (reporterMatch) {
        const existing = reporterMatch[2]!.trimEnd();
        const comma = existing.trim().endsWith(",") || existing.trim() === "" ? "" : ",";
        return configContent.replace(
          reporterMatch[0],
          `${reporterMatch[1]}${existing}${comma}\n    ["agentlens/reporter"],\n  ]`
        );
      }
      // Find use: {} block and add reporter before it
      const useMatch = configContent.match(/(use\s*:\s*\{)/);
      if (useMatch) {
        return configContent.replace(
          useMatch[0],
          `reporter: [\n    ["html"],\n    ["agentlens/reporter"],\n  ],\n  ${useMatch[0]}`
        );
      }
      // Find defineConfig({ and add reporter inside
      const configMatch = configContent.match(/(defineConfig\s*\(\s*\{)/);
      if (configMatch) {
        return configContent.replace(
          configMatch[0],
          `${configMatch[0]}\n  reporter: [\n    ["html"],\n    ["agentlens/reporter"],\n  ],`
        );
      }
      return configContent;
    },
  });

  // Check trace
  const hasRetainOnFailure = /trace\s*:\s*['"]retain-on-failure['"]/.test(configContent);
  const hasTrace = configContent.includes("trace");
  checks.push({
    name: "Trace: retain-on-failure",
    ok: hasRetainOnFailure,
    suggestion: `use: { trace: 'retain-on-failure' }`,
    patch: (!hasRetainOnFailure && hasTrace) ? () => {
      return configContent.replace(
        /trace\s*:\s*['"][^'"]*['"]/,
        `trace: 'retain-on-failure'`
      );
    } : (!hasRetainOnFailure && !hasTrace) ? () => addToUseBlock(configContent, `trace: 'retain-on-failure'`) : null,
  });

  // Check screenshot
  const hasOnlyOnFailure = /screenshot\s*:\s*['"]only-on-failure['"]/.test(configContent);
  const hasScreenshot = configContent.includes("screenshot");
  checks.push({
    name: "Screenshot: only-on-failure",
    ok: hasOnlyOnFailure,
    suggestion: `use: { screenshot: 'only-on-failure' }`,
    patch: (!hasOnlyOnFailure && hasScreenshot) ? () => {
      return configContent.replace(
        /screenshot\s*:\s*['"][^'"]*['"]/,
        `screenshot: 'only-on-failure'`
      );
    } : (!hasOnlyOnFailure && !hasScreenshot) ? () => addToUseBlock(configContent, `screenshot: 'only-on-failure'`) : null,
  });

  // Check video
  const hasVideoOff = /video\s*:\s*['"]off['"]/.test(configContent);
  const hasVideoRetain = /video\s*:\s*['"]retain-on-failure['"]/.test(configContent);
  const hasVideo = configContent.includes("video");
  checks.push({
    name: "Video: off or retain-on-failure",
    ok: hasVideoOff || hasVideoRetain,
    suggestion: `use: { video: 'off' }`,
    patch: (!hasVideoOff && !hasVideoRetain && hasVideo) ? () => {
      return configContent.replace(
        /video\s*:\s*['"][^'"]*['"]/,
        `video: 'off'`
      );
    } : (!hasVideoOff && !hasVideoRetain && !hasVideo) ? () => addToUseBlock(configContent, `video: 'off'`) : null,
  });

  // Display results
  const okChecks = checks.filter((c) => c.ok);
  const failChecks = checks.filter((c) => !c.ok);

  if (okChecks.length > 0) {
    console.log("OK:");
    for (const c of okChecks) console.log(`  + ${c.name}`);
    console.log("");
  }

  if (failChecks.length > 0) {
    if (fix) {
      console.log("Fixing:");
      let content = configContent;
      for (const c of failChecks) {
        if (c.patch) {
          content = c.patch();
          configContent = content; // Update for chained patches
          console.log(`  * ${c.name}`);
        } else {
          console.log(`  ! ${c.name} — cannot auto-fix, please add manually: ${c.suggestion}`);
        }
      }
      await writeFile(configPath, content, "utf-8");
      console.log(`\nWrote ${configPath}`);
    } else {
      console.log("Suggestions:");
      for (const c of failChecks) {
        console.log(`  ! ${c.name}: ${c.suggestion}`);
      }
      console.log("\nRun `agentlens doctor --fix` to apply these changes automatically.");
    }
  } else {
    console.log("Everything looks good!");
  }
}

function addToUseBlock(content: string, property: string): string {
  const useMatch = content.match(/(use\s*:\s*\{)/);
  if (useMatch) {
    return content.replace(useMatch[0], `${useMatch[0]}\n    ${property},`);
  }
  // No use block — find defineConfig and add one
  const configMatch = content.match(/(defineConfig\s*\(\s*\{)/);
  if (configMatch) {
    return content.replace(
      configMatch[0],
      `${configMatch[0]}\n  use: {\n    ${property},\n  },`
    );
  }
  return content;
}

async function ciCommand(): Promise<void> {
  const workflowDir = ".github/workflows";
  const workflowPath = join(workflowDir, "playwright.yml");

  try {
    await access(workflowPath);
    console.log(`${workflowPath} already exists. Not overwriting.`);
    return;
  } catch {
    // File doesn't exist — create it
  }

  await mkdir(workflowDir, { recursive: true });

  const workflow = `# GitHub Actions workflow for Playwright tests with AgentLens
name: Playwright Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run Playwright tests
        run: npx playwright test
        continue-on-error: true

      - name: Upload AgentLens report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: agentlens-report
          path: |
            .agentlens/latest.md
            .agentlens/latest.html
            .agentlens/failures.md
            .agentlens/screenshots/
          retention-days: 14

      - name: Upload Playwright report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
`;
  await writeFile(workflowPath, workflow, "utf-8");
  console.log(`Created ${workflowPath}`);
  console.log("");
  console.log("The workflow will:");
  console.log("  1. Run Playwright tests on push/PR to main");
  console.log("  2. Upload .agentlens/ reports as artifacts");
  console.log("  3. Upload the Playwright HTML report as artifacts");
}

async function writeFileIfNotExists(path: string, content: string): Promise<void> {
  try {
    await access(path);
    console.log(`  (skipped) ${path} already exists`);
  } catch {
    await writeFile(path, content, "utf-8");
  }
}

async function installBrowserCommand(): Promise<void> {
  const { ensureChromium, getCachedVersion } = await import("./browser/download.js");

  const existing = await getCachedVersion();
  if (existing) {
    console.log(`Chromium ${existing} already installed.`);
    console.log("Run with --force to re-download (not yet implemented — delete ~/.agentlens/chromium/ manually).");
    return;
  }

  await ensureChromium({ verbose: true });
}

async function browserStatusCommand(): Promise<void> {
  const { findChrome } = await import("./browser/launcher.js");
  const { getCachedChromium, getCachedVersion } = await import("./browser/download.js");

  console.log("Browser detection:\n");

  const systemChrome = await findChrome();
  if (systemChrome) {
    console.log(`  System Chrome: ${systemChrome}`);
  } else {
    console.log("  System Chrome: not found");
  }

  const cached = await getCachedChromium();
  const version = await getCachedVersion();
  if (cached) {
    console.log(`  Bundled Chrome: ${cached} (v${version})`);
  } else {
    console.log("  Bundled Chrome: not downloaded");
  }

  console.log("");
  if (systemChrome) {
    console.log("AgentLens will use system Chrome.");
  } else if (cached) {
    console.log("AgentLens will use the bundled Chrome.");
  } else {
    console.log("No browser available. AgentLens will auto-download Chrome for Testing on first launch.");
    console.log("Or run: agentlens install-browser");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
