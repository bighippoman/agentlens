/**
 * Browser — launch and manage a browser instance.
 *
 * Usage:
 * ```ts
 * import { Browser } from "agentlens/browser";
 *
 * const browser = await Browser.launch();
 * const page = await browser.newPage();
 * await page.goto("https://example.com");
 * const title = await page.title();
 * await browser.close();
 * ```
 */

import { launchBrowser, createTarget, getTargets, type BrowserProcess, type LaunchOptions } from "./launcher.js";
import { CDPClient } from "./cdp.js";
import { BrowserPage } from "./page.js";

export class Browser {
  private proc: BrowserProcess;
  private debugPort: number;
  private pages: BrowserPage[] = [];

  private constructor(proc: BrowserProcess, debugPort: number) {
    this.proc = proc;
    this.debugPort = debugPort;
  }

  /**
   * Launch a new browser instance.
   */
  static async launch(options?: LaunchOptions): Promise<Browser> {
    const proc = await launchBrowser(options);
    // Extract port from wsEndpoint: ws://127.0.0.1:PORT/devtools/browser/UUID
    const portMatch = proc.wsEndpoint.match(/:(\d+)\//);
    const debugPort = portMatch ? parseInt(portMatch[1]!, 10) : 9222;
    return new Browser(proc, debugPort);
  }

  /**
   * Create a new page (tab).
   */
  async newPage(): Promise<BrowserPage> {
    let wsUrl: string;

    try {
      // Try creating a new target
      const target = await createTarget(this.debugPort);
      wsUrl = target.webSocketDebuggerUrl;
    } catch {
      // Fallback: use an existing about:blank target (Chrome launches with one)
      const targets = await getTargets(this.debugPort);
      const blankTarget = targets.find((t) => t.type === "page");
      if (!blankTarget) {
        throw new Error("No available page target found");
      }
      wsUrl = blankTarget.webSocketDebuggerUrl;
    }

    const cdp = new CDPClient();
    await cdp.connect(wsUrl);
    const page = new BrowserPage(cdp);
    await page.init();
    await page.setViewportSize({ width: 1280, height: 720 });
    this.pages.push(page);
    return page;
  }

  /**
   * Close the browser and all pages.
   */
  async close(): Promise<void> {
    for (const page of this.pages) {
      await page.close();
    }
    this.pages = [];
    await this.proc.close();
  }

  /**
   * The DevTools WebSocket endpoint URL.
   */
  get wsEndpoint(): string {
    return this.proc.wsEndpoint;
  }
}
