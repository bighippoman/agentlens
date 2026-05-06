/**
 * BrowserPage — a high-level page abstraction built on CDP.
 *
 * Provides the methods AgentLens needs:
 * - navigate, evaluate, screenshot
 * - click, fill, check, select
 * - console/network monitoring
 * - viewport management
 *
 * Zero npm dependencies.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { CDPClient } from "./cdp.js";

export interface ConsoleMessage {
  type: string;
  text: string;
}

export interface NetworkResponse {
  url: string;
  status: number;
  method: string;
}

export class BrowserPage {
  private cdp: CDPClient;
  private consoleMessages: ConsoleMessage[] = [];
  private networkResponses: NetworkResponse[] = [];
  private _url = "about:blank";
  private _viewportSize = { width: 1280, height: 720 };

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  /**
   * Initialize CDP domains — must be called after connecting.
   */
  async init(): Promise<void> {
    await Promise.all([
      this.cdp.send("Page.enable"),
      this.cdp.send("Runtime.enable"),
      this.cdp.send("Network.enable"),
      this.cdp.send("DOM.enable"),
    ]);

    // Track console messages
    this.cdp.on("Runtime.consoleAPICalled", (params) => {
      const type = params["type"] as string;
      const args = params["args"] as Array<{ type: string; value?: string; description?: string }>;
      const text = args.map((a) => a.value ?? a.description ?? "").join(" ");
      this.consoleMessages.push({ type, text });
    });

    // Track network responses
    this.cdp.on("Network.responseReceived", (params) => {
      const response = params["response"] as { url: string; status: number };
      const request = params["request"] as { method: string } | undefined;
      // Also try to get method from requestWillBeSent
      this.networkResponses.push({
        url: response.url,
        status: response.status,
        method: request?.method ?? "GET",
      });
    });

    // Track URL changes
    this.cdp.on("Page.frameNavigated", (params) => {
      const frame = params["frame"] as { url: string; parentId?: string };
      if (!frame.parentId) {
        this._url = frame.url;
      }
    });
  }

  // ── Navigation ──

  async goto(url: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const result = await this.cdp.send("Page.navigate", { url });
    if (result["errorText"]) {
      throw new Error(`Navigation failed: ${result["errorText"]}`);
    }
    this._url = url;
    await this.waitForLoad(timeout);
  }

  async goBack(): Promise<void> {
    const history = await this.cdp.send("Page.getNavigationHistory") as {
      currentIndex: number;
      entries: Array<{ url: string }>;
    };
    if (history.currentIndex > 0) {
      const entry = history.entries[history.currentIndex - 1]!;
      await this.cdp.send("Page.navigateToHistoryEntry", { entryId: history.currentIndex - 1 });
      this._url = entry.url;
    }
  }

  url(): string {
    return this._url;
  }

  async title(): Promise<string> {
    const result = await this.evaluate("document.title");
    return result as string;
  }

  // ── JavaScript evaluation ──

  async evaluate<T = unknown>(expression: string): Promise<T>;
  async evaluate<T = unknown, A = unknown>(fn: (arg: A) => T, arg: A): Promise<T>;
  async evaluate<T = unknown>(fnOrExpr: string | ((arg: unknown) => T), arg?: unknown): Promise<T> {
    let expression: string;
    if (typeof fnOrExpr === "function") {
      expression = `(${fnOrExpr.toString()})(${JSON.stringify(arg)})`;
    } else {
      expression = fnOrExpr;
    }

    const result = await this.cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    const exceptionDetails = result["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
    if (exceptionDetails) {
      throw new Error(`Evaluate error: ${exceptionDetails.exception?.description ?? exceptionDetails.text ?? "unknown"}`);
    }

    const value = result["result"] as { value?: T };
    return value?.value as T;
  }

  // ── Screenshots ──

  async screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer> {
    const clip = options?.fullPage ? undefined : {
      x: 0,
      y: 0,
      width: this._viewportSize.width,
      height: this._viewportSize.height,
      scale: 1,
    };

    const result = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      clip,
    });

    const data = Buffer.from(result["data"] as string, "base64");

    if (options?.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, data);
    }

    return data;
  }

  // ── Element interaction ──

  async click(selector: string): Promise<void> {
    await this.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      el.click();
    }, selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.evaluate(({ sel, val }: { sel: string; val: string }) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { sel: selector, val: value });
  }

  async check(selector: string): Promise<void> {
    await this.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      if (!el.checked) el.click();
    }, selector);
  }

  async uncheck(selector: string): Promise<void> {
    await this.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      if (el.checked) el.click();
    }, selector);
  }

  async select(selector: string, value: string): Promise<void> {
    await this.evaluate(({ sel, val }: { sel: string; val: string }) => {
      const el = document.querySelector(sel) as HTMLSelectElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      // Try matching by option label first, then value
      for (const opt of el.options) {
        if (opt.text === val || opt.value === val || opt.label === val) {
          el.value = opt.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
      throw new Error(`No option matching "${val}" in select`);
    }, { sel: selector, val: value });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    for (const char of text) {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        key: char,
      });
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: char,
      });
      // Small delay between keystrokes
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  async press(key: string): Promise<void> {
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: keyToCode(key),
      windowsVirtualKeyCode: keyToKeyCode(key),
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: keyToCode(key),
      windowsVirtualKeyCode: keyToKeyCode(key),
    });
  }

  async hover(selector: string): Promise<void> {
    const box = await this.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector);

    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
    });
  }

  async scrollTo(selector: string): Promise<void> {
    await this.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`No element found for selector: ${sel}`);
      el.scrollIntoView({ behavior: "auto", block: "center" });
    }, selector);
  }

  // ── Viewport ──

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this._viewportSize = size;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  viewportSize(): { width: number; height: number } {
    return { ...this._viewportSize };
  }

  // ── Waiting ──

  async waitForLoad(timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cdp.off("Page.loadEventFired", onLoad);
        reject(new Error(`Page load timed out after ${timeout}ms`));
      }, timeout);

      const onLoad = () => {
        clearTimeout(timer);
        this.cdp.off("Page.loadEventFired", onLoad);
        resolve();
      };

      // Check if already loaded
      this.cdp.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      }).then((result) => {
        const value = result["result"] as { value?: string };
        if (value?.value === "complete") {
          clearTimeout(timer);
          this.cdp.off("Page.loadEventFired", onLoad);
          resolve();
        }
      }).catch(() => {
        // Ignore — wait for event
      });

      this.cdp.on("Page.loadEventFired", onLoad);
    });
  }

  async waitForSelector(selector: string, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const exists = await this.evaluate((sel: string) => {
        return document.querySelector(sel) !== null;
      }, selector);
      if (exists) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Selector "${selector}" not found after ${timeout}ms`);
  }

  async waitForNetworkIdle(timeout = 5000): Promise<void> {
    // Simple: wait until no new network responses for 500ms
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout);
      let lastActivity = Date.now();
      const check = setInterval(() => {
        if (Date.now() - lastActivity > 500) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 100);

      const handler = () => { lastActivity = Date.now(); };
      this.cdp.on("Network.responseReceived", handler);

      setTimeout(() => {
        this.cdp.off("Network.responseReceived", handler);
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }, timeout);
    });
  }

  // ── State ──

  getConsoleMessages(): ConsoleMessage[] {
    return [...this.consoleMessages];
  }

  getNetworkResponses(): NetworkResponse[] {
    return [...this.networkResponses];
  }

  getFailedRequests(): NetworkResponse[] {
    return this.networkResponses.filter((r) => r.status >= 400);
  }

  clearConsole(): void {
    this.consoleMessages = [];
  }

  clearNetwork(): void {
    this.networkResponses = [];
  }

  // ── Cookies ──

  async getCookies(): Promise<Array<{ name: string; domain: string; path: string; secure: boolean; httpOnly: boolean }>> {
    const result = await this.cdp.send("Network.getCookies");
    const cookies = result["cookies"] as Array<{ name: string; domain: string; path: string; secure: boolean; httpOnly: boolean }>;
    return cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    }));
  }

  // ── Close ──

  async close(): Promise<void> {
    this.cdp.close();
  }
}

// ── Key mapping helpers ──

function keyToCode(key: string): string {
  const map: Record<string, string> = {
    Enter: "Enter", Escape: "Escape", Tab: "Tab",
    Backspace: "Backspace", Delete: "Delete",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    " ": "Space",
  };
  return map[key] ?? `Key${key.toUpperCase()}`;
}

function keyToKeyCode(key: string): number {
  const map: Record<string, number> = {
    Enter: 13, Escape: 27, Tab: 9,
    Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40,
    ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
    " ": 32,
  };
  return map[key] ?? key.toUpperCase().charCodeAt(0);
}
