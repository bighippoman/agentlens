import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { AgentPage } from "../src/agent/agent-page.js";
import { detectComponents } from "../src/agent/components.js";
import { detectBlockers } from "../src/agent/blockers.js";
import { auditAccessibility } from "../src/a11y.js";

const FIXTURE = `file://${join(process.cwd(), "tests/fixtures/test-app.html")}`;

test.describe("AgentPage.digest()", () => {
  test("returns a compact page digest", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);
    const digest = await agent.digest();

    expect(digest.url).toContain("test-app.html");
    expect(digest.title).toBe("AgentLens Test App");
    expect(digest.components.length).toBeGreaterThan(0);
    expect(digest.status.readiness).toBe("ready");
    expect(digest.text).toBeTruthy();
    expect(digest.tokens).toBeGreaterThan(0);
    expect(digest.tokens).toBeLessThan(800); // Should be compact
  });

  test("text digest is readable and compact", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);
    const digest = await agent.digest();

    // Should contain page identification
    expect(digest.text).toContain("AgentLens Test App");
    // Should contain status
    expect(digest.text).toContain("Status: ready");
    // Should not contain raw HTML
    expect(digest.text).not.toContain("<");
    expect(digest.text).not.toContain("</");
  });

  test("provides suggested action", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);
    const digest = await agent.digest();

    // The test page has a form with empty required fields
    // or a hero CTA — either way there should be a suggestion
    expect(digest.suggestedAction ?? digest.availableActions.length > 0).toBeTruthy();
  });

  test("provides available actions", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);
    const digest = await agent.digest();

    expect(digest.availableActions.length).toBeGreaterThan(0);
    // Should include navigation items
    const hasNav = digest.availableActions.some((a) => a.includes("navigate"));
    expect(hasNav).toBe(true);
  });
});

test.describe("detectComponents()", () => {
  test("detects navigation", async ({ page }) => {
    await page.goto(FIXTURE);
    const components = await detectComponents(page);
    const nav = components.find((c) => c.type === "nav");

    expect(nav).toBeDefined();
    expect(nav!.items).toBeDefined();
    expect(nav!.items!.length).toBeGreaterThan(0);
    expect(nav!.items!.some((i) => i.text === "Home")).toBe(true);
  });

  test("detects forms with field status", async ({ page }) => {
    await page.goto(FIXTURE);
    const components = await detectComponents(page);
    const form = components.find((c) => c.type === "form");

    expect(form).toBeDefined();
    expect(form!.fields).toBeDefined();
    expect(form!.fields!.length).toBeGreaterThan(0);
    // Text/email/password fields should be empty initially
    const textFields = form!.fields!.filter((f) => f.type !== "checkbox");
    expect(textFields.every((f) => f.empty)).toBe(true);
    // Should have summary
    expect(form!.summary).toContain("filled");
  });

  test("detects hero section", async ({ page }) => {
    await page.goto(FIXTURE);
    const components = await detectComponents(page);
    const hero = components.find((c) => c.type === "hero");

    expect(hero).toBeDefined();
    expect(hero!.name).toContain("Welcome");
    expect(hero!.actions.length).toBeGreaterThan(0);
  });

  test("detects footer", async ({ page }) => {
    await page.goto(FIXTURE);
    const components = await detectComponents(page);
    const footer = components.find((c) => c.type === "footer");

    expect(footer).toBeDefined();
  });
});

test.describe("AgentPage.do() intents", () => {
  test("fill form with intent", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    const result = await agent.do("fill form with {Email: test@example.com, password: secret123}");
    expect(result.success).toBe(true);

    const emailValue = await page.inputValue("#email");
    expect(emailValue).toBe("test@example.com");
  });

  test("submit form intent", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    // Fill first, then submit
    await page.fill("#email", "a@b.com");
    await page.fill("#password", "pass");

    const result = await agent.do("submit form");
    expect(result.success).toBe(true);
    expect(result.description).toContain("Submitted");
  });

  test("navigate intent", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    // Navigate to About (it's a hash link)
    const result = await agent.do("navigate to About");
    expect(result.success).toBe(true);
  });

  test("go back intent", async ({ page }) => {
    await page.goto(FIXTURE);
    await page.goto(FIXTURE + "?page=2");
    const agent = new AgentPage(page);

    const result = await agent.do("go back");
    expect(result.success).toBe(true);
    expect(result.description).toContain("Navigated back");
  });

  test("wait intent", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    const result = await agent.do("wait until ready");
    expect(result.success).toBe(true);
    expect(result.description).toContain("ready");
  });

  test("scroll intent", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    const result = await agent.do("scroll to Footer");
    expect(result.success).toBe(true);
  });

  test("unknown intent returns helpful error", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    const result = await agent.do("dance around");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Supported");
  });
});

test.describe("AgentPage.whatChanged()", () => {
  test("returns full state on first call", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    const delta = await agent.whatChanged();
    expect(delta.unchanged).toBe(false);
    expect(delta.added.length).toBeGreaterThan(0);
    expect(delta.text).toContain("[initial]");
  });

  test("returns [no change] when nothing changed", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    await agent.whatChanged(); // First call — sets baseline
    const delta = await agent.whatChanged(); // Second call — nothing changed
    expect(delta.unchanged).toBe(true);
    expect(delta.text).toBe("[no change]");
    expect(delta.tokens).toBeLessThan(10);
  });

  test("detects form field changes", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);

    await agent.whatChanged(); // Baseline
    await page.fill("#email", "test@example.com");
    const delta = await agent.whatChanged();

    // Should detect the form summary changed
    expect(delta.unchanged).toBe(false);
    expect(delta.changed.length).toBeGreaterThan(0);
  });
});

test.describe("AgentPage.goto()", () => {
  test("navigates and returns digest", async ({ page }) => {
    const agent = new AgentPage(page);
    const digest = await agent.goto(FIXTURE);

    expect(digest.url).toContain("test-app.html");
    expect(digest.components.length).toBeGreaterThan(0);
    expect(digest.status.readiness).toBe("ready");
  });
});

test.describe("AgentPage full journey", () => {
  test("end-to-end: goto → digest → fill → submit → delta", async ({ page }) => {
    const agent = new AgentPage(page);

    // Step 1: Navigate
    const digest = await agent.goto(FIXTURE);
    expect(digest.status.readiness).toBe("ready");
    const formComp = digest.components.find((c) => c.type === "form");
    expect(formComp).toBeDefined();

    // Step 2: Fill the form using intent
    const fillResult = await agent.do("fill form with {Email: user@test.com, password: pass123, name: Test User}");
    expect(fillResult.success).toBe(true);
    // Fill intent produces a delta internally — verify it
    expect(fillResult.delta).not.toBeNull();

    // Step 3: Check that fields were actually filled
    const emailVal = await page.inputValue("#email");
    expect(emailVal).toBe("user@test.com");

    // Step 4: Submit
    const submitResult = await agent.do("submit form");
    expect(submitResult.success).toBe(true);
    expect(submitResult.description).toContain("Submitted");
  });
});

test.describe("blocker detection", () => {
  test("reports no blockers on clean page", async ({ page }) => {
    await page.goto(FIXTURE);
    const blockers = await detectBlockers(page);
    // Our test page has no modals/dialogs
    const realBlockers = blockers.filter((b) => b.type === "dialog" || b.type === "modal");
    expect(realBlockers.length).toBe(0);
  });

  test("dismiss blockers on clean page returns 0", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page);
    const result = await agent.dismissBlockers();
    expect(result.dismissed).toBe(0);
  });
});

test.describe("context budget", () => {
  test("respects token budget", async ({ page }) => {
    await page.goto(FIXTURE);
    const agent = new AgentPage(page, { maxTokens: 200 });
    const digest = await agent.digest();

    // With a tight budget, should still produce output but be compact
    expect(digest.text.length).toBeLessThan(1200); // ~200 tokens × 4 chars + some overhead
    expect(digest.text).toBeTruthy();
  });
});
