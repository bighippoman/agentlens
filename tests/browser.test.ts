import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { Browser, type BrowserPage } from "../src/browser/index.js";

const FIXTURE = `file://${join(process.cwd(), "tests/fixtures/test-app.html")}`;

let browser: Browser;
let page: BrowserPage;

describe("Browser (own driver, zero dependencies)", () => {
  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  }, 30000);

  afterAll(async () => {
    await browser.close();
  });

  it("launches Chrome and creates a page", () => {
    expect(browser.wsEndpoint).toContain("ws://");
    expect(page).toBeDefined();
  });

  it("navigates to a URL", async () => {
    await page.goto(FIXTURE);
    expect(page.url()).toContain("test-app.html");
  });

  it("gets page title", async () => {
    const title = await page.title();
    expect(title).toBe("AgentLens Test App");
  });

  it("evaluates JavaScript", async () => {
    const result = await page.evaluate("1 + 1");
    expect(result).toBe(2);
  });

  it("evaluates functions with arguments", async () => {
    const result = await page.evaluate(
      (x: number) => x * 3,
      7
    );
    expect(result).toBe(21);
  });

  it("queries the DOM", async () => {
    const heading = await page.evaluate(
      "document.querySelector('h1').textContent"
    );
    expect(heading).toBe("Welcome to Test App");
  });

  it("takes a viewport screenshot", async () => {
    const buffer = await page.screenshot();
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000); // A real PNG
    // PNG magic bytes
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it("clicks elements", async () => {
    await page.goto(FIXTURE);
    await page.click('[data-testid="primary-cta"]');
    const text = await page.evaluate(
      "document.querySelector('.hero p').textContent"
    );
    expect(text).toBe("You clicked Get Started!");
  });

  it("fills inputs", async () => {
    await page.goto(FIXTURE);
    await page.fill("#email", "test@example.com");
    const value = await page.evaluate(
      'document.querySelector("#email").value'
    );
    expect(value).toBe("test@example.com");
  });

  it("checks checkboxes", async () => {
    await page.goto(FIXTURE);
    await page.check("#terms");
    const checked = await page.evaluate(
      'document.querySelector("#terms").checked'
    );
    expect(checked).toBe(true);
  });

  it("selects from dropdowns", async () => {
    await page.goto(FIXTURE);
    await page.select("#country", "United States");
    const value = await page.evaluate(
      'document.querySelector("#country").value'
    );
    expect(value).toBe("us");
  });

  it("presses keyboard keys", async () => {
    await page.press("Tab");
    // Just verify it doesn't throw
  });

  it("waits for selectors", async () => {
    await page.goto(FIXTURE);
    await page.waitForSelector("h1");
    // Should resolve immediately since h1 exists
  });

  it("gets cookies", async () => {
    const cookies = await page.getCookies();
    expect(Array.isArray(cookies)).toBe(true);
  });

  it("tracks console messages", async () => {
    await page.clearConsole();
    await page.evaluate('console.log("hello from test")');
    const messages = await page.getConsoleMessages();
    expect(messages.some((m) => m.text.includes("hello from test"))).toBe(true);
  });

  it("reports viewport size", () => {
    const size = page.viewportSize();
    expect(size.width).toBe(1280);
    expect(size.height).toBe(720);
  });
});
