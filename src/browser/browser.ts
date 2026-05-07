/**
 * Browser — launch or connect to a browser instance.
 *
 * Two modes:
 *
 * ```ts
 * // Headless — works for most sites, fully invisible
 * const browser = await Browser.launch();
 *
 * // Connect to real Chrome — for Cloudflare-protected sites
 * const browser = await Browser.connect(9222);
 * // (start Chrome yourself with: chrome --remote-debugging-port=9222)
 * ```
 */

import { launchBrowser, createTarget, type BrowserProcess, type LaunchOptions } from "./launcher.js";
import { CDPClient } from "./cdp.js";
import { BrowserPage } from "./page.js";
import { get } from "node:http";

export class Browser {
  private proc: BrowserProcess | null;
  private debugPort: number;
  private pages: BrowserPage[] = [];
  private isExternal: boolean;

  private constructor(proc: BrowserProcess | null, debugPort: number, isExternal: boolean) {
    this.proc = proc;
    this.debugPort = debugPort;
    this.isExternal = isExternal;
  }

  /**
   * Launch headless Chrome. Works for most sites.
   *
   * For sites with strict bot detection (Cloudflare Turnstile, etc.),
   * use Browser.connect() to attach to a real Chrome instance instead.
   */
  static async launch(options?: LaunchOptions): Promise<Browser> {
    const proc = await launchBrowser(options);
    const portMatch = proc.wsEndpoint.match(/:(\d+)\//);
    const debugPort = portMatch ? parseInt(portMatch[1]!, 10) : 9222;
    return new Browser(proc, debugPort, false);
  }

  /**
   * Connect to an already-running Chrome instance.
   *
   * This produces an authentic TLS fingerprint because it IS real Chrome.
   * Use this for sites that block headless browsers (Cloudflare, Akamai, etc.).
   *
   * Start Chrome with remote debugging:
   *   macOS:  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
   *   Linux:  google-chrome --remote-debugging-port=9222
   *
   * Then connect:
   *   const browser = await Browser.connect(9222);
   */
  static async connect(portOrUrl: number | string): Promise<Browser> {
    let debugPort: number;

    if (typeof portOrUrl === "number") {
      debugPort = portOrUrl;
    } else {
      const match = portOrUrl.match(/:(\d+)/);
      if (!match) throw new Error(`Cannot parse port from: ${portOrUrl}`);
      debugPort = parseInt(match[1]!, 10);
    }

    try {
      await getTargetsFromPort(debugPort);
    } catch {
      throw new Error(
        `Cannot connect to Chrome on port ${debugPort}.\n\n` +
        `Start Chrome with remote debugging enabled:\n` +
        `  macOS:  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${debugPort}\n` +
        `  Linux:  google-chrome --remote-debugging-port=${debugPort}\n`
      );
    }

    return new Browser(null, debugPort, true);
  }

  /**
   * Create a new page (tab).
   */
  async newPage(): Promise<BrowserPage> {
    let wsUrl: string;

    try {
      const target = await createTarget(this.debugPort);
      wsUrl = target.webSocketDebuggerUrl;
    } catch {
      // HTTP create failed — try CDP Target.createTarget
      try {
        const browserWs = await this.getBrowserWsUrl();
        const browserCdp = new CDPClient();
        await browserCdp.connect(browserWs);
        const result = await browserCdp.send("Target.createTarget", { url: "about:blank" });
        const targetId = (result as { targetId: string }).targetId;
        browserCdp.close();
        const targets = await getTargetsFromPort(this.debugPort);
        const newTarget = targets.find((t) => t.id === targetId) ?? targets.find((t) => t.type === "page");
        if (!newTarget) throw new Error("Created target but cannot find it");
        wsUrl = newTarget.webSocketDebuggerUrl;
      } catch {
        const targets = await getTargetsFromPort(this.debugPort);
        const pageTarget = targets.find((t) => t.type === "page");
        if (!pageTarget) throw new Error("No available page target found");
        wsUrl = pageTarget.webSocketDebuggerUrl;
      }
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
   * Close the browser. If connected to an external Chrome, only closes
   * the pages we opened — doesn't kill the browser.
   */
  async close(): Promise<void> {
    for (const page of this.pages) {
      await page.close();
    }
    this.pages = [];
    if (this.proc && !this.isExternal) {
      await this.proc.close();
    }
  }

  get wsEndpoint(): string {
    return this.proc?.wsEndpoint ?? `ws://127.0.0.1:${this.debugPort}`;
  }

  private async getBrowserWsUrl(): Promise<string> {
    if (this.proc?.wsEndpoint) return this.proc.wsEndpoint;
    return new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${this.debugPort}/json/version`, (res) => {
        let data = "";
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const info = JSON.parse(data) as { webSocketDebuggerUrl: string };
            resolve(info.webSocketDebuggerUrl);
          } catch (e) { reject(e); }
        });
      }).on("error", reject);
    });
  }
}

function getTargetsFromPort(port: number): Promise<Array<{ id: string; type: string; title: string; url: string; webSocketDebuggerUrl: string }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connection timed out")), 5000);
    get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
