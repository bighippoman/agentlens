import type { BrowserPage } from "../browser/page.js";
import type { IntentResult } from "./types.js";
import { getPageDigest } from "./digest.js";
import { getPageDelta } from "./delta.js";
import { waitUntilReady, dismissBlockers } from "./blockers.js";

export async function executeIntent(page: BrowserPage, intent: string): Promise<IntentResult> {
  const trimmed = intent.trim();
  const lower = trimmed.toLowerCase();

  try {
    if (lower === "dismiss blockers") return handleDismissBlockers(page);
    if (lower === "wait until ready" || lower === "wait") return handleWait(page);
    if (lower === "go back" || lower === "back") return handleGoBack(page);

    const loginMatch = trimmed.match(/^log\s*in\s+with\s+(.+?)\s*\/\s*(.+)$/i);
    if (loginMatch) return handleLogin(page, loginMatch[1]!.trim(), loginMatch[2]!.trim());

    const searchMatch = trimmed.match(/^search\s+(?:for\s+)?(?:"|')?(.+?)(?:"|')?$/i);
    if (searchMatch) return handleSearch(page, searchMatch[1]!);

    const navMatch = trimmed.match(/^(?:navigate|go)\s+to\s+(?:"|')?(.+?)(?:"|')?$/i);
    if (navMatch) return handleNavigate(page, navMatch[1]!);

    const submitMatch = trimmed.match(/^submit\s*(?:the\s+)?(?:form)?(?:\s+(?:"|')?(.+?)(?:"|')?)?$/i);
    if (submitMatch) return handleSubmitForm(page, submitMatch[1]);

    const fillFormMatch = trimmed.match(/^fill\s+(?:the\s+)?(?:form\s+)?(?:"|')?(.+?)(?:"|')?\s+with\s+\{(.+)\}$/i);
    if (fillFormMatch) return handleFillForm(page, fillFormMatch[2]!);

    const scrollMatch = trimmed.match(/^scroll\s+(?:to|down\s+to)\s+(?:"|')?(.+?)(?:"|')?$/i);
    if (scrollMatch) return handleScroll(page, scrollMatch[1]!);

    return { intent: trimmed, success: false, description: `Unknown intent: "${trimmed}"`, error: `Supported: "submit form", "fill form with {field: value}", "navigate to [page]", "log in with [email] / [password]", "search for [query]", "go back", "scroll to [component]", "dismiss blockers", "wait until ready"`, delta: null };
  } catch (err) {
    return { intent: trimmed, success: false, description: `Error executing "${trimmed}"`, error: err instanceof Error ? err.message : String(err), delta: null };
  }
}

async function handleDismissBlockers(page: BrowserPage): Promise<IntentResult> {
  const { dismissed, remaining } = await dismissBlockers(page);
  const delta = await getPageDelta(page);
  return { intent: "dismiss blockers", success: remaining.length === 0, description: dismissed > 0 ? `Dismissed ${dismissed} blocker(s).` : "No dismissable blockers found.", error: remaining.length > 0 ? `${remaining.length} non-dismissable blocker(s) remain` : null, delta };
}

async function handleWait(page: BrowserPage): Promise<IntentResult> {
  const status = await waitUntilReady(page);
  const delta = await getPageDelta(page);
  return { intent: "wait until ready", success: status.readiness === "ready", description: `Page is ${status.readiness}.`, error: status.readiness !== "ready" ? `Page still ${status.readiness}` : null, delta };
}

async function handleGoBack(page: BrowserPage): Promise<IntentResult> {
  await page.goBack();
  await page.waitForLoad(5000).catch(() => {});
  const delta = await getPageDelta(page);
  return { intent: "go back", success: true, description: `Navigated back to ${page.url()}`, error: null, delta };
}

async function handleLogin(page: BrowserPage, email: string, password: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const form = digest.components.find((c) => {
    if (c.type !== "form") return false;
    const fields = c.fields ?? [];
    return fields.some((f) => /email|username|user|login/i.test(f.label + f.name + f.type)) && fields.some((f) => f.type === "password");
  });

  if (!form?.fields) {
    return { intent: "log in", success: false, description: "No login form found.", error: `Found ${digest.components.filter((c) => c.type === "form").length} form(s) but none look like a login form.`, delta: null };
  }

  const emailField = form.fields.find((f) => /email|username|user|login/i.test(f.label + f.name + f.type));
  if (emailField) await fillFieldByName(page, emailField.name, email);

  const passwordField = form.fields.find((f) => f.type === "password");
  if (passwordField) await fillFieldByName(page, passwordField.name, password);

  // Click submit
  await page.evaluate((sel: string) => {
    const form = document.querySelector(sel);
    if (!form) return;
    const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as HTMLElement | null;
    if (btn) btn.click();
  }, form.selector);

  await page.waitForNetworkIdle(5000).catch(() => {});
  const delta = await getPageDelta(page);
  return { intent: "log in", success: true, description: `Filled login form and submitted. ${delta.navigated ? `Navigated to ${delta.newUrl}` : "Stayed on same page."}`, error: null, delta };
}

async function handleSearch(page: BrowserPage, query: string): Promise<IntentResult> {
  try {
    await page.evaluate((q: string) => {
      const selectors = [
        'input[type="search"]',
        'input[name="q"]',
        'textarea[name="q"]',
        '[role="searchbox"]',
        '[role="combobox"][name*="q"]',
        'input[name*="search"]',
        'input[name*="query"]',
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'textarea[aria-label*="Search" i]',
        'textarea[role="combobox"]',
      ];
      let input: HTMLInputElement | HTMLTextAreaElement | null = null;
      for (const sel of selectors) {
        input = document.querySelector(sel) as HTMLInputElement | null;
        if (input) break;
      }
      if (!input) throw new Error("No search input found");
      input.focus();
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, query);
    await page.press("Enter");
    await page.waitForNetworkIdle(5000).catch(() => {});
    const delta = await getPageDelta(page);
    return { intent: `search for "${query}"`, success: true, description: `Searched for "${query}".`, error: null, delta };
  } catch {
    return { intent: `search for "${query}"`, success: false, description: "No search input found.", error: "Could not find a search input.", delta: null };
  }
}

async function handleNavigate(page: BrowserPage, target: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const lower = target.toLowerCase();

  for (const comp of digest.components) {
    if (comp.type !== "nav" || !comp.items) continue;
    for (const item of comp.items) {
      if (item.text.toLowerCase().includes(lower) || lower.includes(item.text.toLowerCase())) {
        await page.goto(item.href);
        const delta = await getPageDelta(page);
        return { intent: `navigate to "${target}"`, success: true, description: `Navigated to "${item.text}" (${item.href}).`, error: null, delta };
      }
    }
  }

  // Try clicking a link with matching text
  const clicked = await page.evaluate((t: string) => {
    const links = document.querySelectorAll("a[href]");
    for (const link of links) {
      if ((link.textContent || "").trim().toLowerCase().includes(t.toLowerCase())) {
        (link as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, target);

  if (clicked) {
    await page.waitForLoad(5000).catch(() => {});
    const delta = await getPageDelta(page);
    return { intent: `navigate to "${target}"`, success: true, description: `Clicked link "${target}".`, error: null, delta };
  }

  return { intent: `navigate to "${target}"`, success: false, description: `No link matching "${target}" found.`, error: `Available: ${digest.components.filter((c) => c.type === "nav").flatMap((c) => c.items ?? []).map((i) => i.text).join(", ") || "none"}`, delta: null };
}

async function handleSubmitForm(page: BrowserPage, formName?: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const forms = digest.components.filter((c) => c.type === "form");
  let target = forms[0];
  if (formName) {
    const lower = formName.toLowerCase();
    target = forms.find((f) => f.name.toLowerCase().includes(lower)) ?? forms[0];
  }
  if (!target) return { intent: "submit form", success: false, description: "No form found.", error: null, delta: null };

  await page.evaluate((sel: string) => {
    const form = document.querySelector(sel);
    if (!form) return;
    const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as HTMLElement | null;
    if (btn) btn.click();
  }, target.selector);

  await page.waitForNetworkIdle(5000).catch(() => {});
  const delta = await getPageDelta(page);
  return { intent: `submit form "${target.name}"`, success: true, description: `Submitted "${target.name}".`, error: null, delta };
}

async function handleFillForm(page: BrowserPage, dataStr: string): Promise<IntentResult> {
  const pairs: [string, string][] = [];
  for (const part of dataStr.split(",")) {
    const match = part.match(/\s*(?:"|')?(.+?)(?:"|')?\s*:\s*(?:"|')?(.+?)(?:"|')?\s*$/);
    if (match) pairs.push([match[1]!, match[2]!]);
  }
  if (pairs.length === 0) return { intent: "fill form", success: false, description: "Could not parse field data.", error: `Expected: {field1: value1, field2: value2}`, delta: null };

  let filled = 0;
  for (const [field, value] of pairs) {
    try { await fillFieldByName(page, field, value); filled++; } catch { /* field not found */ }
  }
  const delta = await getPageDelta(page);
  return { intent: "fill form", success: filled === pairs.length, description: `Filled ${filled}/${pairs.length} fields.`, error: filled < pairs.length ? `${pairs.length - filled} field(s) not found` : null, delta };
}

async function handleScroll(page: BrowserPage, target: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const lower = target.toLowerCase();
  const comp = digest.components.find((c) => c.name.toLowerCase().includes(lower));
  if (comp) {
    try { await page.scrollTo(comp.selector); const delta = await getPageDelta(page); return { intent: `scroll to "${target}"`, success: true, description: `Scrolled to "${comp.name}".`, error: null, delta }; } catch { /* fall through */ }
  }
  // Try scrolling to text or common landmarks
  const found = await page.evaluate((t: string) => {
    // For "footer"/"bottom", scroll to page bottom
    if (/footer|bottom|end/i.test(t)) {
      const footer = document.querySelector('footer, [role="contentinfo"]');
      if (footer) { (footer as HTMLElement).scrollIntoView({ behavior: "auto", block: "center" }); return true; }
      window.scrollTo(0, document.body.scrollHeight);
      return true;
    }
    // For "top"/"header", scroll to top
    if (/top|header|start/i.test(t)) {
      window.scrollTo(0, 0);
      return true;
    }
    // Try text search
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent || "").toLowerCase().includes(t.toLowerCase())) {
        (walker.currentNode.parentElement as HTMLElement)?.scrollIntoView({ behavior: "auto", block: "center" });
        return true;
      }
    }
    return false;
  }, target);
  if (found) { const delta = await getPageDelta(page); return { intent: `scroll to "${target}"`, success: true, description: `Scrolled to "${target}".`, error: null, delta }; }
  return { intent: `scroll to "${target}"`, success: false, description: `Could not find "${target}".`, error: `Available: ${digest.components.map((c) => c.name).join(", ")}`, delta: null };
}

async function fillFieldByName(page: BrowserPage, name: string, value: string): Promise<void> {
  const filled = await page.evaluate(({ name, value }: { name: string; value: string }) => {
    // Try by name attribute
    let el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    // Try by id
    if (!el) el = document.getElementById(name) as HTMLInputElement | null;
    // Try by label text
    if (!el) {
      const labels = document.querySelectorAll("label");
      for (const label of labels) {
        if ((label.textContent || "").toLowerCase().includes(name.toLowerCase())) {
          const forId = label.getAttribute("for");
          if (forId) el = document.getElementById(forId) as HTMLInputElement | null;
          if (!el) el = label.querySelector("input, textarea, select") as HTMLInputElement | null;
          if (el) break;
        }
      }
    }
    // Try by placeholder
    if (!el) el = document.querySelector(`[placeholder*="${name}" i]`) as HTMLInputElement | null;
    // Try by aria-label
    if (!el) el = document.querySelector(`[aria-label*="${name}" i]`) as HTMLInputElement | null;

    if (!el) return false;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { name, value });

  if (!filled) throw new Error(`No input matching "${name}" found`);
}
