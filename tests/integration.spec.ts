import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { observe } from "../src/observe.js";
import { getVisibleState } from "../src/visible-state.js";
import { act } from "../src/act.js";
import { uxReport, uxReportHtml } from "../src/ux-report.js";
import { resetSession } from "../src/session.js";
import { auditAccessibility } from "../src/a11y.js";
import { matchAgentSnapshot } from "../src/snapshot.js";
import type { ObservationLog } from "../src/types.js";

const OUTPUT_DIR = ".agentlens-test";
const opts = { outputDir: OUTPUT_DIR };
const FIXTURE = `file://${join(process.cwd(), "tests/fixtures/test-app.html")}`;
const SNAPSHOT_PATH = join(OUTPUT_DIR, "snapshots", "test.snapshot.json");

test.beforeAll(async () => {
  await resetSession(OUTPUT_DIR);
});

test.afterAll(async () => {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
});

test.describe("getVisibleState", () => {
  test("collects page state without page.content()", async ({ page }) => {
    await page.goto(FIXTURE);
    const state = await getVisibleState(page, opts);

    expect(state.url).toContain("test-app.html");
    expect(state.title).toBe("AgentLens Test App");
    expect(state.viewportSize.width).toBeGreaterThan(0);
    expect(state.headings.length).toBeGreaterThan(0);
    expect(state.headings[0]).toEqual({ level: 1, text: "Welcome to Test App" });
    expect(state.buttons.length).toBeGreaterThan(0);
    expect(state.links.length).toBeGreaterThan(0);
    expect(state.inputs.length).toBeGreaterThan(0);
    expect(state.interactiveElements.length).toBeGreaterThan(0);
  });

  test("finds inputs with labels", async ({ page }) => {
    await page.goto(FIXTURE);
    const state = await getVisibleState(page, opts);

    const emailInput = state.inputs.find((i) => i.name === "email");
    expect(emailInput).toBeDefined();
    expect(emailInput!.ariaLabel).toBe("Email");
    expect(emailInput!.placeholder).toBe("you@example.com");
  });

  test("respects maxElements cap", async ({ page }) => {
    await page.goto(FIXTURE);
    const state = await getVisibleState(page, { ...opts, maxElements: 3 });
    expect(state.interactiveElements.length).toBeLessThanOrEqual(3);
  });
});

test.describe("observe", () => {
  test("takes screenshot and creates observation log", async ({ page }) => {
    await resetSession(OUTPUT_DIR);
    await page.goto(FIXTURE);
    const obs = await observe(page, "Homepage loaded", opts);

    expect(obs.step).toBe(1);
    expect(obs.label).toBe("Homepage loaded");
    expect(obs.screenshotPath).toContain("001-homepage-loaded.png");
    expect(obs.visibleState.url).toContain("test-app.html");
    expect(obs.diff).toBeNull(); // First observation has no diff

    // Verify JSON log was created
    const logRaw = await readFile(join(OUTPUT_DIR, "latest.json"), "utf-8");
    const log: ObservationLog = JSON.parse(logRaw);
    expect(log.observations.length).toBe(1);
    expect(log.observations[0]!.label).toBe("Homepage loaded");

    // Verify MD report was created
    const md = await readFile(join(OUTPUT_DIR, "latest.md"), "utf-8");
    expect(md).toContain("AgentLens UX Report");
    expect(md).toContain("Homepage loaded");
  });

  test("computes diff between observations", async ({ page }) => {
    await resetSession(OUTPUT_DIR);
    await page.goto(FIXTURE);
    await observe(page, "Before click", opts);

    // Click the CTA which changes the page text
    await page.click('[data-testid="primary-cta"]');
    const obs2 = await observe(page, "After click", opts);

    expect(obs2.step).toBe(2);
    expect(obs2.diff).not.toBeNull();
  });
});

test.describe("act", () => {
  test("click by text", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "click Learn More", opts);
    expect(result.success).toBe(true);
    expect(result.action).toContain("click");
  });

  test("click primary CTA", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "click primary CTA", opts);
    expect(result.success).toBe(true);
  });

  test("fill input by label", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "fill Email with test@example.com", opts);
    expect(result.success).toBe(true);

    // Verify the input was filled
    const value = await page.inputValue("#email");
    expect(value).toBe("test@example.com");
  });

  test("fill with fuzzy matching", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "fill Full Name with Jane Doe", opts);
    expect(result.success).toBe(true);
    const value = await page.inputValue("#name");
    expect(value).toBe("Jane Doe");
  });

  test("select from dropdown", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "select United States in Country", opts);
    expect(result.success).toBe(true);
    const value = await page.inputValue("#country");
    expect(value).toBe("us");
  });

  test("check checkbox", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "check Terms and Conditions", opts);
    expect(result.success).toBe(true);
    const checked = await page.isChecked("#terms");
    expect(checked).toBe(true);
  });

  test("press key", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "press Tab", opts);
    expect(result.success).toBe(true);
    expect(result.action).toBe("press");
  });

  test("returns error for no match", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "click Nonexistent Button XYZ", opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No clickable element");
  });

  test("returns error for unrecognized instruction", async ({ page }) => {
    await page.goto(FIXTURE);
    const result = await act(page, "dance the macarena", opts);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unrecognized instruction");
  });
});

test.describe("uxReport", () => {
  test("generates markdown report from observations", async ({ page }) => {
    await resetSession(OUTPUT_DIR);
    await page.goto(FIXTURE);
    await observe(page, "Homepage", opts);
    await act(page, "fill Email with a@b.com", opts);
    await observe(page, "After fill", opts);

    const md = await uxReport(opts);

    expect(md).toContain("AgentLens UX Report");
    expect(md).toContain("Homepage");
    expect(md).toContain("After fill");
    expect(md).toContain("## Current State");
    expect(md).toContain("## Context Avoided");
  });

  test("generates HTML report", async ({ page }) => {
    await resetSession(OUTPUT_DIR);
    await page.goto(FIXTURE);
    await observe(page, "For HTML", opts);

    const html = await uxReportHtml(opts);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("AgentLens UX Report");
    expect(html).toContain("data:image/png;base64,");
  });
});

test.describe("accessibility audit", () => {
  test("detects common violations", async ({ page }) => {
    await page.goto(FIXTURE);
    const violations = await auditAccessibility(page);

    // Should find the unlabeled button and missing alt
    const hasButtonName = violations.some((v) => v.rule === "button-name");
    const hasImageAlt = violations.some((v) => v.rule === "image-alt");
    expect(hasButtonName).toBe(true);
    expect(hasImageAlt).toBe(true);
  });
});

test.describe("snapshot", () => {
  test("creates and matches snapshot", async ({ page }) => {
    await page.goto(FIXTURE);
    const state = await getVisibleState(page, opts);

    // First call creates the snapshot
    const result1 = await matchAgentSnapshot(state, SNAPSHOT_PATH);
    expect(result1.match).toBe(true);
    expect(result1.created).toBe(true);

    // Second call matches it
    const result2 = await matchAgentSnapshot(state, SNAPSHOT_PATH);
    expect(result2.match).toBe(true);
    expect(result2.created).toBeUndefined();
  });
});

test.describe("full journey", () => {
  test("end-to-end: observe → act → observe → report", async ({ page }) => {
    await resetSession(OUTPUT_DIR);
    await page.goto(FIXTURE);

    // Step 1: Observe initial state
    const obs1 = await observe(page, "Landing page", opts);
    expect(obs1.step).toBe(1);
    expect(obs1.visibleState.headings.some((h) => h.text === "Welcome to Test App")).toBe(true);

    // Step 2: Fill out the form
    await act(page, "fill Email with user@test.com", opts);
    await act(page, "fill Password with secret123", opts);
    await act(page, "fill Full Name with Test User", opts);
    await act(page, "select United States in Country", opts);
    await act(page, "check Terms and Conditions", opts);

    // Step 3: Observe after filling
    const obs2 = await observe(page, "Form filled", opts);
    expect(obs2.step).toBe(2);
    expect(obs2.diff).not.toBeNull();

    // Step 4: Submit
    await act(page, "click Submit", opts);
    const obs3 = await observe(page, "After submit", opts);
    expect(obs3.step).toBe(3);

    // Step 5: Generate report
    const md = await uxReport(opts);
    expect(md).toContain("Landing page");
    expect(md).toContain("Form filled");
    expect(md).toContain("After submit");
    expect(md).toContain("Context Avoided");

    // Verify all screenshots exist
    const log: ObservationLog = JSON.parse(
      await readFile(join(OUTPUT_DIR, "latest.json"), "utf-8")
    );
    expect(log.observations.length).toBe(3);
    for (const obs of log.observations) {
      expect(obs.screenshotPath).toBeTruthy();
    }
  });
});
