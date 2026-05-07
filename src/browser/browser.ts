/**
 * Browser — launch, connect to, or manage browser instances.
 *
 * Three ways to get a browser:
 *
 * ```ts
 * // 1. Launch headless (default — works for most sites)
 * const browser = await Browser.launch();
 *
 * // 2. Launch non-headless (real TLS fingerprint — works for all sites)
 * const browser = await Browser.launch({ headless: false });
 *
 * // 3. Connect to existing Chrome (real everything — maximum compatibility)
 * // Start Chrome with: chrome --remote-debugging-port=9222
 * const browser = await Browser.connect(9222);
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
  private isHeadless: boolean;

  private constructor(proc: BrowserProcess | null, debugPort: number, isExternal: boolean, isHeadless = true) {
    this.proc = proc;
    this.debugPort = debugPort;
    this.isExternal = isExternal;
    this.isHeadless = isHeadless;
  }

  /**
   * Launch a new browser instance.
   *
   * By default launches headless Chrome. For sites with strict bot detection,
   * use `{ headless: false }` which produces a real TLS fingerprint.
   *
   * On Linux without a display, AgentLens automatically uses xvfb if available.
   */
  static async launch(options?: LaunchOptions): Promise<Browser> {
    const wantVisible = options?.headless === false;

    // On Linux without DISPLAY, auto-wrap with xvfb for non-headless mode
    if (wantVisible && process.platform === "linux" && !process.env["DISPLAY"]) {
      const hasXvfb = await checkCommand("xvfb-run");
      if (hasXvfb) {
        // Set a virtual display for this process
        process.env["DISPLAY"] = ":99";
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("Xvfb", [":99", "-screen", "0", "1920x1080x24"], { stdio: "ignore" });
        } catch {
          // Xvfb might already be running
        }
      }
    }

    const proc = await launchBrowser(options);
    const portMatch = proc.wsEndpoint.match(/:(\d+)\//);
    const debugPort = portMatch ? parseInt(portMatch[1]!, 10) : 9222;
    return new Browser(proc, debugPort, false, options?.headless ?? true);
  }

  /**
   * Connect to an already-running Chrome instance.
   *
   * This gives the most authentic browser fingerprint because it IS real Chrome.
   * The TLS fingerprint, HTTP/2 settings, and all network-level signals are
   * indistinguishable from a regular browser session.
   *
   * Start Chrome with:
   *   google-chrome --remote-debugging-port=9222
   *
   * Then connect:
   *   const browser = await Browser.connect(9222);
   *   const page = await browser.newPage();
   */
  static async connect(portOrUrl: number | string): Promise<Browser> {
    let debugPort: number;

    if (typeof portOrUrl === "number") {
      debugPort = portOrUrl;
    } else {
      // Extract port from ws:// URL
      const match = portOrUrl.match(/:(\d+)/);
      if (!match) throw new Error(`Cannot parse port from: ${portOrUrl}`);
      debugPort = parseInt(match[1]!, 10);
    }

    // Verify the connection works
    try {
      await getTargetsFromPort(debugPort);
    } catch {
      throw new Error(
        `Cannot connect to Chrome on port ${debugPort}.\n` +
        `Start Chrome with: google-chrome --remote-debugging-port=${debugPort}\n` +
        `Or on macOS: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${debugPort}`
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
      const targets = await getTargetsFromPort(this.debugPort);
      const pageTarget = targets.find((t) => t.type === "page");
      if (!pageTarget) throw new Error("No available page target found");
      wsUrl = pageTarget.webSocketDebuggerUrl;
    }

    const cdp = new CDPClient();
    await cdp.connect(wsUrl);
    const page = new BrowserPage(cdp);
    await page.init();
    await page.setViewportSize({ width: 1280, height: 720 });

    // In non-headless mode, minimize the window so it doesn't appear on screen
    if (!this.isHeadless) {
      try {
        const windowId = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", {
          windowId: (windowId as { windowId: number }).windowId,
          bounds: { windowState: "minimized" },
        });
      } catch {
        // Browser.getWindowForTarget may not be available — window stays visible
      }
    }

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
}

// ── Helpers ──

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

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
