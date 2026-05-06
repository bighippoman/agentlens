import type { Page } from "@playwright/test";
import type {
  AgentLensOptions,
  ConsoleError,
  InteractiveElement,
  PerformanceMetrics,
  StorageState,
  VisibleState,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { truncate } from "./utils.js";

interface PageContext {
  consoleErrors: Map<string, number>;
  failedRequests: { url: string; status: number; method: string }[];
  lastErrorSnapshot: Map<string, number>;
  lastRequestCursor: number;
}

const pageContexts = new WeakMap<Page, PageContext>();

/**
 * Attach console/network listeners to a page. Idempotent — safe to call multiple times.
 */
export function setupListeners(page: Page): PageContext {
  const existing = pageContexts.get(page);
  if (existing) return existing;

  const ctx: PageContext = {
    consoleErrors: new Map(),
    failedRequests: [],
    lastErrorSnapshot: new Map(),
    lastRequestCursor: 0,
  };
  pageContexts.set(page, ctx);

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      ctx.consoleErrors.set(text, (ctx.consoleErrors.get(text) ?? 0) + 1);
    }
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      ctx.failedRequests.push({
        url: response.url(),
        status,
        method: response.request().method(),
      });
    }
  });

  return ctx;
}

/**
 * Get deduplicated errors and new requests since the last drain.
 */
export function drainErrors(page: Page): {
  consoleErrors: ConsoleError[];
  failedRequests: { url: string; status: number; method: string }[];
} {
  const ctx = setupListeners(page);

  // Compute new errors since last snapshot
  const newErrors: ConsoleError[] = [];
  for (const [message, totalCount] of ctx.consoleErrors) {
    const prevCount = ctx.lastErrorSnapshot.get(message) ?? 0;
    const delta = totalCount - prevCount;
    if (delta > 0) {
      newErrors.push({ message, count: delta });
    }
  }
  // Update snapshot
  ctx.lastErrorSnapshot = new Map(ctx.consoleErrors);

  // New failed requests
  const newRequests = ctx.failedRequests.slice(ctx.lastRequestCursor);
  ctx.lastRequestCursor = ctx.failedRequests.length;

  return {
    consoleErrors: newErrors.slice(0, 50),
    failedRequests: newRequests.slice(0, 50),
  };
}

/**
 * Collect the visible state of a page without calling page.content().
 */
export async function getVisibleState(
  page: Page,
  options?: AgentLensOptions
): Promise<VisibleState> {
  const maxElements = options?.maxElements ?? DEFAULTS.maxElements;
  const maxTextLength = options?.maxTextLength ?? DEFAULTS.maxTextLength;
  const capturePerformance = options?.capturePerformance ?? DEFAULTS.capturePerformance;
  const captureStorage = options?.captureStorage ?? DEFAULTS.captureStorage;

  setupListeners(page);

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
  } catch {
    // Collect whatever is available
  }

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

  const promises: [
    Promise<string>,
    Promise<string>,
    Promise<VisibleState["headings"]>,
    Promise<VisibleState["buttons"]>,
    Promise<VisibleState["links"]>,
    Promise<VisibleState["inputs"]>,
    Promise<InteractiveElement[]>,
    Promise<PerformanceMetrics | null>,
    Promise<StorageState | null>,
  ] = [
    Promise.resolve(page.url()),
    page.title(),
    collectHeadings(page, maxTextLength, viewport),
    collectButtons(page, maxTextLength, viewport),
    collectLinks(page, maxTextLength, viewport),
    collectInputs(page, maxTextLength, viewport),
    collectInteractiveElements(page, maxElements, maxTextLength, viewport),
    capturePerformance ? collectPerformanceMetrics(page) : Promise.resolve(null),
    captureStorage ? collectStorageState(page) : Promise.resolve(null),
  ];

  const [url, title, headings, buttons, links, inputs, interactiveElements, performance, storage] =
    await Promise.all(promises);

  const { consoleErrors, failedRequests } = drainErrors(page);

  return {
    url,
    title: truncate(title, maxTextLength),
    viewportSize: viewport,
    headings,
    buttons,
    links,
    inputs,
    interactiveElements,
    consoleErrors,
    failedRequests,
    performance,
    storage,
  };
}

// --- Performance metrics ---

async function collectPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType("paint");
    const lcpEntries = (performance as unknown as { getEntriesByType(t: string): PerformanceEntry[] })
      .getEntriesByType("largest-contentful-paint");

    let cls: number | null = null;
    try {
      const layoutShifts = (performance as unknown as { getEntriesByType(t: string): Array<{ value: number; hadRecentInput: boolean }> })
        .getEntriesByType("layout-shift");
      if (layoutShifts.length > 0) {
        cls = layoutShifts
          .filter((e) => !e.hadRecentInput)
          .reduce((sum, e) => sum + e.value, 0);
        cls = Math.round(cls * 1000) / 1000;
      }
    } catch {
      // CLS not available
    }

    return {
      lcp: lcpEntries.length > 0
        ? Math.round(lcpEntries[lcpEntries.length - 1]!.startTime)
        : paint.find((p) => p.name === "first-contentful-paint")?.startTime
          ? Math.round(paint.find((p) => p.name === "first-contentful-paint")!.startTime)
          : null,
      cls,
      ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
      load: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
    };
  });
}

// --- Storage state ---

async function collectStorageState(page: Page): Promise<StorageState> {
  const context = page.context();
  const rawCookies = await context.cookies();
  const cookies = rawCookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
  }));

  const storageKeys = await page.evaluate(() => {
    const localKeys: string[] = [];
    const sessionKeys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) localKeys.push(key);
      }
    } catch { /* localStorage not available */ }
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key) sessionKeys.push(key);
      }
    } catch { /* sessionStorage not available */ }
    return { localKeys, sessionKeys };
  });

  return {
    cookies,
    localStorageKeys: storageKeys.localKeys,
    sessionStorageKeys: storageKeys.sessionKeys,
  };
}

// --- Element collectors (with viewport intersection) ---

type Viewport = { width: number; height: number };

async function collectHeadings(
  page: Page,
  maxTextLength: number,
  viewport: Viewport
): Promise<VisibleState["headings"]> {
  return page.evaluate(
    ({ maxLen, vw, vh }) => {
      const els = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const results: { level: number; text: string }[] = [];
      for (const el of els) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null) {
          const pos = getComputedStyle(htmlEl).position;
          if (pos !== "fixed" && pos !== "sticky") continue;
        }
        if (getComputedStyle(htmlEl).visibility === "hidden") continue;
        if (getComputedStyle(htmlEl).display === "none") continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
        const text = (htmlEl.innerText || htmlEl.textContent || "").trim();
        if (!text) continue;
        const level = parseInt(el.tagName[1]!, 10);
        results.push({
          level,
          text: text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text,
        });
      }
      return results;
    },
    { maxLen: maxTextLength, vw: viewport.width, vh: viewport.height }
  );
}

async function collectButtons(
  page: Page,
  maxTextLength: number,
  viewport: Viewport
): Promise<VisibleState["buttons"]> {
  return page.evaluate(
    ({ maxLen, vw, vh }) => {
      const els = document.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"]'
      );
      const results: { text: string; ariaLabel: string | null; disabled: boolean }[] = [];
      for (const el of els) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null) {
          const pos = getComputedStyle(htmlEl).position;
          if (pos !== "fixed" && pos !== "sticky") continue;
        }
        if (getComputedStyle(htmlEl).visibility === "hidden") continue;
        if (getComputedStyle(htmlEl).display === "none") continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
        const text = (
          (htmlEl as HTMLButtonElement).value ||
          htmlEl.innerText ||
          htmlEl.textContent ||
          ""
        ).trim();
        results.push({
          text: text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text,
          ariaLabel: htmlEl.getAttribute("aria-label"),
          disabled: (htmlEl as HTMLButtonElement).disabled ?? false,
        });
      }
      return results;
    },
    { maxLen: maxTextLength, vw: viewport.width, vh: viewport.height }
  );
}

async function collectLinks(
  page: Page,
  maxTextLength: number,
  viewport: Viewport
): Promise<VisibleState["links"]> {
  return page.evaluate(
    ({ maxLen, vw, vh }) => {
      const els = document.querySelectorAll('a[href], [role="link"]');
      const results: { text: string; href: string; ariaLabel: string | null }[] = [];
      for (const el of els) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null) {
          const pos = getComputedStyle(htmlEl).position;
          if (pos !== "fixed" && pos !== "sticky") continue;
        }
        if (getComputedStyle(htmlEl).visibility === "hidden") continue;
        if (getComputedStyle(htmlEl).display === "none") continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
        const text = (htmlEl.innerText || htmlEl.textContent || "").trim();
        results.push({
          text: text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text,
          href: (htmlEl as HTMLAnchorElement).href || htmlEl.getAttribute("href") || "",
          ariaLabel: htmlEl.getAttribute("aria-label"),
        });
      }
      return results;
    },
    { maxLen: maxTextLength, vw: viewport.width, vh: viewport.height }
  );
}

async function collectInputs(
  page: Page,
  maxTextLength: number,
  viewport: Viewport
): Promise<VisibleState["inputs"]> {
  return page.evaluate(
    ({ maxLen, vw, vh }) => {
      const els = document.querySelectorAll(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select"
      );
      const results: {
        type: string | null;
        name: string | null;
        placeholder: string | null;
        ariaLabel: string | null;
        label: string | null;
        value: string;
      }[] = [];
      for (const el of els) {
        const htmlEl = el as HTMLInputElement;
        if (htmlEl.offsetParent === null) {
          const pos = getComputedStyle(htmlEl).position;
          if (pos !== "fixed" && pos !== "sticky") continue;
        }
        if (getComputedStyle(htmlEl).visibility === "hidden") continue;
        if (getComputedStyle(htmlEl).display === "none") continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
        let label: string | null = null;
        const id = htmlEl.id;
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`);
          if (labelEl) {
            label = (labelEl.textContent || "").trim();
            if (label.length > maxLen) label = label.slice(0, maxLen - 3) + "...";
          }
        }
        if (!label) {
          const closest = htmlEl.closest("label");
          if (closest) {
            label = (closest.textContent || "").trim();
            if (label.length > maxLen) label = label.slice(0, maxLen - 3) + "...";
          }
        }
        results.push({
          type: htmlEl.type || htmlEl.tagName.toLowerCase(),
          name: htmlEl.name || null,
          placeholder: htmlEl.placeholder || null,
          ariaLabel: htmlEl.getAttribute("aria-label"),
          label,
          value: (htmlEl.value || "").slice(0, maxLen),
        });
      }
      return results;
    },
    { maxLen: maxTextLength, vw: viewport.width, vh: viewport.height }
  );
}

async function collectInteractiveElements(
  page: Page,
  maxElements: number,
  maxTextLength: number,
  viewport: Viewport
): Promise<InteractiveElement[]> {
  return page.evaluate(
    ({ maxEl, maxLen, vw, vh }) => {
      const selector = [
        "a[href]",
        "button",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[role="option"]',
        "input:not([type=hidden])",
        "textarea",
        "select",
        "[tabindex]:not([tabindex='-1'])",
        "[onclick]",
      ].join(", ");

      const seen = new Set<Element>();
      const els = document.querySelectorAll(selector);
      const results: {
        tag: string;
        text: string;
        role: string | null;
        ariaLabel: string | null;
        testId: string | null;
        type: string | null;
        placeholder: string | null;
        name: string | null;
        href: string | null;
        rect: { x: number; y: number; width: number; height: number };
        visible: boolean;
      }[] = [];

      for (const el of els) {
        if (results.length >= maxEl) break;
        if (seen.has(el)) continue;
        seen.add(el);

        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null) {
          const pos = getComputedStyle(htmlEl).position;
          if (pos !== "fixed" && pos !== "sticky") continue;
        }
        if (getComputedStyle(htmlEl).visibility === "hidden") continue;
        if (getComputedStyle(htmlEl).display === "none") continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const inViewport =
          rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
        const text = (
          (htmlEl as HTMLButtonElement).value ||
          htmlEl.innerText ||
          htmlEl.textContent ||
          ""
        ).trim();

        results.push({
          tag: htmlEl.tagName.toLowerCase(),
          text: text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text,
          role: htmlEl.getAttribute("role"),
          ariaLabel: htmlEl.getAttribute("aria-label"),
          testId:
            htmlEl.getAttribute("data-testid") ||
            htmlEl.getAttribute("data-test-id") ||
            htmlEl.getAttribute("data-cy") ||
            null,
          type: (htmlEl as HTMLInputElement).type || null,
          placeholder: (htmlEl as HTMLInputElement).placeholder || null,
          name: (htmlEl as HTMLInputElement).name || null,
          href: (htmlEl as HTMLAnchorElement).href || htmlEl.getAttribute("href") || null,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          visible: inViewport,
        });
      }

      return results;
    },
    { maxEl: maxElements, maxLen: maxTextLength, vw: viewport.width, vh: viewport.height }
  );
}
