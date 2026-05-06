import type { Page, BrowserContext } from "@playwright/test";
import type { ContextBudget, IntentResult, PageDelta, PageDigest } from "./types.js";
import { getPageDigest } from "./digest.js";
import { getPageDelta, setBaseline, clearBaseline } from "./delta.js";
import { waitUntilReady, dismissBlockers as dismissBlockersFn } from "./blockers.js";
import { executeIntent } from "./intent.js";
import { observe } from "../observe.js";
import type { Observation } from "../types.js";

/**
 * AgentPage — an AI-agent-native wrapper around a Playwright Page.
 *
 * Instead of raw DOM operations, AgentPage provides:
 * - page.digest() → compact semantic page model (< 500 tokens)
 * - page.do(intent) → high-level actions ("submit form", "navigate to pricing")
 * - page.whatChanged() → delta from last observation
 * - page.waitUntilReady() → smart waiting (not timers)
 * - page.dismissBlockers() → auto-close modals/banners
 * - page.screenshot(label) → viewport screenshot + observation log
 *
 * Usage:
 * ```ts
 * const agent = new AgentPage(page);
 * const digest = await agent.digest();
 * // digest.text → compact page summary for context window
 * // digest.suggestedAction → what to do next
 * await agent.do("fill form with {email: user@test.com, password: secret}");
 * await agent.do("submit form");
 * const delta = await agent.whatChanged();
 * // delta.text → only what changed
 * ```
 */
export class AgentPage {
  readonly page: Page;
  private budget: ContextBudget;

  constructor(page: Page, budget?: Partial<ContextBudget>) {
    this.page = page;
    this.budget = {
      maxTokens: budget?.maxTokens ?? 500,
      priority: budget?.priority ?? ["errors", "blockers", "forms", "nav", "content", "tables"],
    };
  }

  /**
   * Get a compact, semantic digest of the current page.
   *
   * The returned `text` field is designed to be dropped directly into
   * an agent's context window. Typically < 500 tokens.
   */
  async digest(): Promise<PageDigest> {
    return getPageDigest(this.page, this.budget);
  }

  /**
   * Execute a high-level intent.
   *
   * Examples:
   * - "submit form"
   * - "navigate to pricing"
   * - "log in with user@test.com / password123"
   * - "search for typescript playwright"
   * - "fill form with {email: user@test.com, name: John}"
   * - "dismiss blockers"
   * - "wait until ready"
   * - "go back"
   * - "scroll to footer"
   */
  async do(intent: string): Promise<IntentResult> {
    return executeIntent(this.page, intent);
  }

  /**
   * Get what changed since the last digest/whatChanged call.
   *
   * Returns a compact delta — typically < 100 tokens when nothing
   * meaningful changed. "[no change]" if identical.
   */
  async whatChanged(): Promise<PageDelta> {
    return getPageDelta(this.page, this.budget);
  }

  /**
   * Wait until the page is truly ready for interaction.
   *
   * Watches for: network idle, spinners gone, DOM stable.
   * Unlike setTimeout, this resolves as soon as conditions are met.
   */
  async waitUntilReady(timeout?: number): Promise<void> {
    await waitUntilReady(this.page, { timeout });
  }

  /**
   * Dismiss all dismissable blockers (modals, cookie banners, overlays).
   */
  async dismissBlockers(): Promise<{ dismissed: number }> {
    const { dismissed } = await dismissBlockersFn(this.page);
    return { dismissed };
  }

  /**
   * Take a viewport screenshot and log an observation.
   * Bridges to the original agentlens observe() system.
   */
  async screenshot(label: string): Promise<Observation> {
    return observe(this.page, label);
  }

  /**
   * Navigate to a URL and wait until ready.
   */
  async goto(url: string): Promise<PageDigest> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await waitUntilReady(this.page, { timeout: 10000 });
    clearBaseline(this.page);
    const digest = await this.digest();
    setBaseline(this.page, digest);
    return digest;
  }

  /**
   * Set the context budget for digest output.
   */
  setBudget(budget: Partial<ContextBudget>): void {
    if (budget.maxTokens !== undefined) this.budget.maxTokens = budget.maxTokens;
    if (budget.priority !== undefined) this.budget.priority = [...budget.priority];
  }

  /**
   * Create an AgentPage for each open tab in the context.
   */
  static allTabs(context: BrowserContext, budget?: Partial<ContextBudget>): AgentPage[] {
    return context.pages().map((p) => new AgentPage(p, budget));
  }
}
