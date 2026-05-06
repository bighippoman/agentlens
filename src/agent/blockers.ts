import type { BrowserPage } from "../browser/page.js";
import type { PageBlocker, PageStatus } from "./types.js";

/**
 * Detect what's blocking interaction on the page.
 */
export async function detectBlockers(page: BrowserPage): Promise<PageBlocker[]> {
  return page.evaluate(() => {
    const blockers: { type: "modal" | "dialog" | "overlay" | "spinner" | "toast" | "cookie-banner"; description: string; dismissable: boolean; selector: string }[] = [];
    function textOf(el: Element) { return ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 80); }
    function selectorOf(el: Element) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\\s+/).slice(0, 2).map(c => CSS.escape(c)).join(".")}` : "";
      return `${tag}${cls}`.slice(0, 60);
    }
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    for (const d of dialogs) {
      if (getComputedStyle(d as HTMLElement).display === "none") continue;
      const closeBtn = d.querySelector('[aria-label="close"], [aria-label="Close"], .close, button[class*="close"], button[class*="dismiss"]');
      blockers.push({ type: "dialog", description: textOf(d).slice(0, 60), dismissable: closeBtn !== null || d.tagName === "DIALOG", selector: selectorOf(d) });
    }
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
      if ((el as HTMLElement).getAttribute("role") === "dialog") continue;
      const closeBtn = el.querySelector('button, [role="button"]');
      if (isCookie) blockers.push({ type: "cookie-banner", description: "Cookie consent banner", dismissable: closeBtn !== null, selector: selectorOf(el) });
      else if (isSpinner) blockers.push({ type: "spinner", description: "Loading overlay", dismissable: false, selector: selectorOf(el) });
      else if (rect.height > window.innerHeight * 0.3) blockers.push({ type: "overlay", description: text.slice(0, 50) || "Overlay", dismissable: closeBtn !== null, selector: selectorOf(el) });
    }
    const spinners = document.querySelectorAll('[role="progressbar"], [aria-busy="true"], .spinner, .loading, [class*="spinner"], [class*="loading"]');
    for (const s of spinners) {
      if (getComputedStyle(s as HTMLElement).display === "none") continue;
      const rect = (s as HTMLElement).getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) { blockers.push({ type: "spinner", description: "Loading spinner", dismissable: false, selector: selectorOf(s) }); break; }
    }
    return blockers;
  }, undefined);
}

export async function detectStatus(page: BrowserPage): Promise<PageStatus> {
  const blockers = await detectBlockers(page);
  const hasSpinner = blockers.some((b) => b.type === "spinner");
  const hasBlockingModal = blockers.some((b) => b.type === "dialog" || b.type === "modal" || b.type === "overlay");
  const consoleErrors = page.getConsoleMessages().filter((m) => m.type === "error").length;
  const failedRequests = page.getFailedRequests().length;
  const readiness: PageStatus["readiness"] = hasSpinner ? "loading" : hasBlockingModal ? "blocked" : (consoleErrors > 0 || failedRequests > 0) ? "error" : "ready";
  return { readiness, blockers, pendingNetwork: 0, hasSpinner, consoleErrors, failedRequests };
}

export async function waitUntilReady(page: BrowserPage, options?: { timeout?: number }): Promise<PageStatus> {
  const timeout = options?.timeout ?? 10000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { await page.waitForNetworkIdle(Math.min(2000, timeout - (Date.now() - start))); } catch { /* keep trying */ }
    const status = await detectStatus(page);
    if (status.readiness === "ready" || status.readiness === "error") return status;
    await new Promise((r) => setTimeout(r, 300));
  }
  return detectStatus(page);
}

export async function dismissBlockers(page: BrowserPage): Promise<{ dismissed: number; remaining: PageBlocker[] }> {
  const blockers = await detectBlockers(page);
  let dismissed = 0;
  for (const blocker of blockers) {
    if (!blocker.dismissable) continue;
    try {
      // Try clicking close buttons inside the blocker
      const closed = await page.evaluate((sel: string) => {
        const container = document.querySelector(sel);
        if (!container) return false;
        const closeBtn = container.querySelector('[aria-label="close"], [aria-label="Close"], .close, button[class*="close"], button[class*="dismiss"]') as HTMLElement | null;
        if (closeBtn) { closeBtn.click(); return true; }
        // For cookie banners, try accept buttons
        const acceptBtn = container.querySelector('button') as HTMLElement | null;
        if (acceptBtn && /accept|ok|got it|agree|allow/i.test(acceptBtn.textContent || "")) { acceptBtn.click(); return true; }
        return false;
      }, blocker.selector);
      if (closed) { dismissed++; continue; }
      // Last resort: press Escape for dialogs
      if (blocker.type === "dialog") { await page.press("Escape"); dismissed++; }
    } catch { /* couldn't dismiss */ }
  }
  const remaining = await detectBlockers(page);
  return { dismissed, remaining };
}
