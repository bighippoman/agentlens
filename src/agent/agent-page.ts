import type { BrowserPage } from "../browser/page.js";
import type { ContextBudget, IntentResult, PageDelta, PageDigest } from "./types.js";
import { getPageDigest } from "./digest.js";
import { getPageDelta, setBaseline, clearBaseline } from "./delta.js";
import { waitUntilReady, dismissBlockers as dismissBlockersFn } from "./blockers.js";
import { executeIntent } from "./intent.js";

/**
 * AgentPage — an AI-agent-native wrapper around a browser page.
 *
 * Zero external dependencies. Uses our own browser driver built on Chrome DevTools Protocol.
 *
 * ```ts
 * import { Browser } from "agentlens/browser";
 * import { AgentPage } from "agentlens/agent";
 *
 * const browser = await Browser.launch();
 * const page = await browser.newPage();
 * const agent = new AgentPage(page);
 *
 * const digest = await agent.goto("https://myapp.com");
 * await agent.do("log in with user@test.com / secret");
 * const delta = await agent.whatChanged();
 * await browser.close();
 * ```
 */
export class AgentPage {
  readonly page: BrowserPage;
  private budget: ContextBudget;

  constructor(page: BrowserPage, budget?: Partial<ContextBudget>) {
    this.page = page;
    this.budget = {
      maxTokens: budget?.maxTokens ?? 500,
      priority: budget?.priority ?? ["errors", "blockers", "forms", "nav", "content", "tables"],
    };
  }

  /** Compact semantic page digest. Typically < 500 tokens. */
  async digest(): Promise<PageDigest> {
    return getPageDigest(this.page, this.budget);
  }

  /** Execute a high-level intent: "submit form", "navigate to Pricing", "log in with email / pass" */
  async do(intent: string): Promise<IntentResult> {
    return executeIntent(this.page, intent);
  }

  /** What changed since last digest/whatChanged. "[no change]" if nothing. */
  async whatChanged(): Promise<PageDelta> {
    return getPageDelta(this.page, this.budget);
  }

  /** Smart wait: spinners gone, network idle, DOM stable. */
  async waitUntilReady(timeout?: number): Promise<void> {
    await waitUntilReady(this.page, { timeout });
  }

  /** Auto-close modals, cookie banners, overlays. */
  async dismissBlockers(): Promise<{ dismissed: number }> {
    const { dismissed } = await dismissBlockersFn(this.page);
    return { dismissed };
  }

  /** Take a viewport screenshot. */
  async screenshot(path?: string): Promise<Buffer> {
    return this.page.screenshot({ path });
  }

  /** Navigate to a URL, wait until ready, return digest. */
  async goto(url: string): Promise<PageDigest> {
    await this.page.goto(url);
    await waitUntilReady(this.page, { timeout: 10000 });

    // Wait for DOM to stabilize (mutations stop for 500ms)
    // Wrapped in try/catch — page may navigate (e.g., Cloudflare redirect after challenge)
    try {
      await this.page.evaluate(`new Promise(resolve => {
        let timer;
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => { observer.disconnect(); resolve(); }, 500);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
      })`);
    } catch {
      // Page navigated during stability wait — wait for new page to load
      await this.page.waitForLoad(10000).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }

    clearBaseline(this.page);
    const digest = await this.digest();

    // If 0 components, one more attempt after additional wait
    if (digest.components.length === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await getPageDigest(this.page, this.budget);
      if (retry.components.length > 0) {
        setBaseline(this.page, retry);
        return retry;
      }
    }

    setBaseline(this.page, digest);
    return digest;
  }

  /** Set the context budget for digest output. */
  setBudget(budget: Partial<ContextBudget>): void {
    if (budget.maxTokens !== undefined) this.budget.maxTokens = budget.maxTokens;
    if (budget.priority !== undefined) this.budget.priority = [...budget.priority];
  }
}
