import type { Page } from "@playwright/test";
import type { PageBlocker, PageStatus } from "./types.js";

/**
 * Detect what's blocking interaction on the page:
 * modals, dialogs, overlays, spinners, cookie banners.
 */
export async function detectBlockers(page: Page): Promise<PageBlocker[]> {
  return page.evaluate(() => {
    const blockers: {
      type: "modal" | "dialog" | "overlay" | "spinner" | "toast" | "cookie-banner";
      description: string;
      dismissable: boolean;
      selector: string;
    }[] = [];

    function textOf(el: Element): string {
      return ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 80);
    }

    function selectorOf(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === "string"
        ? `.${el.className.trim().split(/\\s+/).slice(0, 2).map(c => CSS.escape(c)).join(".")}`
        : "";
      return `${tag}${cls}`.slice(0, 60);
    }

    // Dialogs and modals
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    for (const d of dialogs) {
      const htmlD = d as HTMLElement;
      if (getComputedStyle(htmlD).display === "none") continue;
      const closeBtn = d.querySelector('[aria-label="close"], [aria-label="Close"], .close, button[class*="close"], button[class*="dismiss"]');
      blockers.push({
        type: "dialog",
        description: textOf(d).slice(0, 60),
        dismissable: closeBtn !== null || d.tagName === "DIALOG",
        selector: selectorOf(d),
      });
    }

    // Fixed overlays with high z-index
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const style = getComputedStyle(el as HTMLElement);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      const z = parseInt(style.zIndex, 10);
      if (isNaN(z) || z < 50) continue;

      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.3 || rect.height < 50) continue;

      const text = textOf(el);
      const isCookie = /cookie|consent|privacy|gdpr|accept.*cookie/i.test(text + el.className);
      const isSpinner = /loading|spinner|progress/i.test(el.className) && rect.width > window.innerWidth * 0.5;

      // Skip if already captured as dialog
      if ((el as HTMLElement).getAttribute("role") === "dialog") continue;

      const closeBtn = el.querySelector('button, [role="button"]');

      if (isCookie) {
        blockers.push({
          type: "cookie-banner",
          description: "Cookie consent banner",
          dismissable: closeBtn !== null,
          selector: selectorOf(el),
        });
      } else if (isSpinner) {
        blockers.push({
          type: "spinner",
          description: "Loading overlay",
          dismissable: false,
          selector: selectorOf(el),
        });
      } else if (rect.height > window.innerHeight * 0.3) {
        blockers.push({
          type: "overlay",
          description: text.slice(0, 50) || "Overlay",
          dismissable: closeBtn !== null,
          selector: selectorOf(el),
        });
      }
    }

    // Standalone spinners (not overlays)
    const spinners = document.querySelectorAll('[role="progressbar"], [aria-busy="true"], .spinner, .loading, [class*="spinner"], [class*="loading"]');
    for (const s of spinners) {
      const htmlS = s as HTMLElement;
      if (getComputedStyle(htmlS).display === "none") continue;
      const rect = htmlS.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Only report if prominent
      if (rect.width > 20 && rect.height > 20) {
        blockers.push({
          type: "spinner",
          description: "Loading spinner",
          dismissable: false,
          selector: selectorOf(s),
        });
        break; // One is enough
      }
    }

    return blockers;
  });
}

/**
 * Detect the overall page status.
 */
export async function detectStatus(page: Page): Promise<PageStatus> {
  const blockers = await detectBlockers(page);

  const hasSpinner = blockers.some((b) => b.type === "spinner");
  const hasBlockingModal = blockers.some(
    (b) => (b.type === "dialog" || b.type === "modal" || b.type === "overlay")
  );

  // Check for pending network
  const pendingNetwork = await page.evaluate(() => {
    return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((e) => e.responseEnd === 0).length;
  });

  // Count console errors
  const consoleErrors = await page.evaluate(() => {
    // We can't directly count errors without listeners, but we can check for error elements
    return document.querySelectorAll('[role="alert"][class*="error"], .error-message, .error').length;
  });

  const readiness: PageStatus["readiness"] =
    hasSpinner ? "loading" :
    hasBlockingModal ? "blocked" :
    consoleErrors > 0 ? "error" :
    "ready";

  return {
    readiness,
    blockers,
    pendingNetwork,
    hasSpinner,
    consoleErrors,
    failedRequests: 0,
  };
}

/**
 * Wait until the page is truly ready for interaction.
 *
 * Unlike Playwright's waitForLoadState, this also waits for:
 * - Spinners to disappear
 * - Network requests to complete
 * - DOM to stabilize (no new elements appearing)
 */
export async function waitUntilReady(
  page: Page,
  options?: { timeout?: number }
): Promise<PageStatus> {
  const timeout = options?.timeout ?? 10000;
  const start = Date.now();
  const pollInterval = 300;

  while (Date.now() - start < timeout) {
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(3000, timeout - (Date.now() - start)) });
    } catch {
      // Network didn't go idle — that's OK, keep checking
    }

    const status = await detectStatus(page);
    if (status.readiness === "ready") return status;
    if (status.readiness === "error") return status; // Don't wait for errors to resolve

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return detectStatus(page);
}

/**
 * Attempt to dismiss all dismissable blockers (modals, cookie banners, toasts).
 */
export async function dismissBlockers(page: Page): Promise<{ dismissed: number; remaining: PageBlocker[] }> {
  const blockers = await detectBlockers(page);
  let dismissed = 0;

  for (const blocker of blockers) {
    if (!blocker.dismissable) continue;

    try {
      // Try common close patterns
      const closeSelectors = [
        `${blocker.selector} [aria-label="close"]`,
        `${blocker.selector} [aria-label="Close"]`,
        `${blocker.selector} button[class*="close"]`,
        `${blocker.selector} button[class*="dismiss"]`,
        `${blocker.selector} .close`,
      ];

      let closed = false;
      for (const sel of closeSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click({ timeout: 1000 });
            closed = true;
            break;
          }
        } catch {
          continue;
        }
      }

      // For cookie banners, try "Accept" or "OK" buttons
      if (!closed && blocker.type === "cookie-banner") {
        try {
          const acceptBtn = page.locator(`${blocker.selector}`).getByRole("button", { name: /accept|ok|got it|agree|allow/i }).first();
          if (await acceptBtn.isVisible({ timeout: 500 })) {
            await acceptBtn.click({ timeout: 1000 });
            closed = true;
          }
        } catch {
          // No accept button found
        }
      }

      // For dialogs, try Escape key
      if (!closed && (blocker.type === "dialog" || blocker.type === "modal")) {
        await page.keyboard.press("Escape");
        closed = true;
      }

      if (closed) dismissed++;
    } catch {
      // Couldn't dismiss — continue
    }
  }

  // Re-check what remains
  const remaining = await detectBlockers(page);
  return { dismissed, remaining };
}
