import type { Page } from "@playwright/test";
import type { IntentResult } from "./types.js";
import { getPageDigest } from "./digest.js";
import { getPageDelta } from "./delta.js";
import { waitUntilReady, dismissBlockers } from "./blockers.js";

/**
 * Execute a high-level intent on the page.
 *
 * Unlike act() which operates on individual elements, this operates on
 * semantic concepts: "submit the form", "navigate to pricing", "log in".
 *
 * Supported intents:
 * - "submit form" / "submit [form name]"
 * - "fill form with { field: value, ... }"
 * - "navigate to [page name]"
 * - "log in with [email] / [password]"
 * - "search for [query]"
 * - "go back"
 * - "scroll to [component]"
 * - "dismiss blockers"
 * - "wait until ready"
 */
export async function executeIntent(
  page: Page,
  intent: string
): Promise<IntentResult> {
  const trimmed = intent.trim();
  const lower = trimmed.toLowerCase();

  try {
    if (lower === "dismiss blockers") {
      return handleDismissBlockers(page);
    }
    if (lower === "wait until ready" || lower === "wait") {
      return handleWait(page);
    }
    if (lower === "go back" || lower === "back") {
      return handleGoBack(page);
    }

    // "log in with email / password"
    const loginMatch = trimmed.match(/^log\s*in\s+with\s+(.+?)\s*\/\s*(.+)$/i);
    if (loginMatch) {
      return handleLogin(page, loginMatch[1]!.trim(), loginMatch[2]!.trim());
    }

    // "search for [query]"
    const searchMatch = trimmed.match(/^search\s+(?:for\s+)?(?:"|')?(.+?)(?:"|')?$/i);
    if (searchMatch) {
      return handleSearch(page, searchMatch[1]!);
    }

    // "navigate to [page]"
    const navMatch = trimmed.match(/^(?:navigate|go)\s+to\s+(?:"|')?(.+?)(?:"|')?$/i);
    if (navMatch) {
      return handleNavigate(page, navMatch[1]!);
    }

    // "submit form" / "submit [name]"
    const submitMatch = trimmed.match(/^submit\s*(?:the\s+)?(?:form)?(?:\s+(?:"|')?(.+?)(?:"|')?)?$/i);
    if (submitMatch) {
      return handleSubmitForm(page, submitMatch[1]);
    }

    // "fill form with {}" or "fill [form] with {}"
    const fillFormMatch = trimmed.match(/^fill\s+(?:the\s+)?(?:form\s+)?(?:"|')?(.+?)(?:"|')?\s+with\s+\{(.+)\}$/i);
    if (fillFormMatch) {
      return handleFillForm(page, fillFormMatch[1] ?? undefined, fillFormMatch[2]!);
    }

    // "scroll to [component]"
    const scrollMatch = trimmed.match(/^scroll\s+(?:to|down\s+to)\s+(?:"|')?(.+?)(?:"|')?$/i);
    if (scrollMatch) {
      return handleScroll(page, scrollMatch[1]!);
    }

    return {
      intent: trimmed,
      success: false,
      description: `Unknown intent: "${trimmed}"`,
      error: `Supported: "submit form", "fill form with {field: value}", "navigate to [page]", "log in with [email] / [password]", "search for [query]", "go back", "scroll to [component]", "dismiss blockers", "wait until ready"`,
      delta: null,
    };
  } catch (err) {
    return {
      intent: trimmed,
      success: false,
      description: `Error executing "${trimmed}"`,
      error: err instanceof Error ? err.message : String(err),
      delta: null,
    };
  }
}

// ── Intent handlers ──

async function handleDismissBlockers(page: Page): Promise<IntentResult> {
  const { dismissed, remaining } = await dismissBlockers(page);
  const delta = await getPageDelta(page);
  return {
    intent: "dismiss blockers",
    success: remaining.length === 0,
    description: dismissed > 0
      ? `Dismissed ${dismissed} blocker(s). ${remaining.length > 0 ? `${remaining.length} remaining.` : "Page is clear."}`
      : "No dismissable blockers found.",
    error: remaining.length > 0 ? `${remaining.length} non-dismissable blocker(s) remain` : null,
    delta,
  };
}

async function handleWait(page: Page): Promise<IntentResult> {
  const status = await waitUntilReady(page);
  const delta = await getPageDelta(page);
  return {
    intent: "wait until ready",
    success: status.readiness === "ready",
    description: `Page is ${status.readiness}.`,
    error: status.readiness !== "ready" ? `Page still ${status.readiness}` : null,
    delta,
  };
}

async function handleGoBack(page: Page): Promise<IntentResult> {
  await page.goBack({ waitUntil: "domcontentloaded" });
  const delta = await getPageDelta(page);
  return {
    intent: "go back",
    success: true,
    description: `Navigated back to ${page.url()}`,
    error: null,
    delta,
  };
}

async function handleLogin(page: Page, email: string, password: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);

  // Find a form that looks like a login form
  const form = digest.components.find((c) => {
    if (c.type !== "form") return false;
    const fields = c.fields ?? [];
    const hasEmail = fields.some((f) =>
      /email|username|user|login/i.test(f.label + f.name + f.type)
    );
    const hasPassword = fields.some((f) => f.type === "password");
    return hasEmail && hasPassword;
  });

  if (!form || !form.fields) {
    return {
      intent: "log in",
      success: false,
      description: "No login form found on this page.",
      error: `Found ${digest.components.filter((c) => c.type === "form").length} form(s) but none look like a login form (need email/username + password fields).`,
      delta: null,
    };
  }

  // Fill email/username field
  const emailField = form.fields.find((f) =>
    /email|username|user|login/i.test(f.label + f.name + f.type)
  );
  if (emailField) {
    await fillFieldByName(page, emailField.name, email);
  }

  // Fill password field
  const passwordField = form.fields.find((f) => f.type === "password");
  if (passwordField) {
    await fillFieldByName(page, passwordField.name, password);
  }

  // Submit
  if (form.actions.length > 0) {
    await page.getByRole("button", { name: form.actions[0] }).click();
  } else {
    // Try pressing Enter
    await page.keyboard.press("Enter");
  }

  // Wait for navigation/response
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch { /* may not navigate */ }

  const delta = await getPageDelta(page);
  return {
    intent: "log in",
    success: true,
    description: `Filled login form and submitted. ${delta.navigated ? `Navigated to ${delta.newUrl}` : "Stayed on same page."}`,
    error: null,
    delta,
  };
}

async function handleSearch(page: Page, query: string): Promise<IntentResult> {
  // Find search input
  const searchInput = page.locator(
    'input[type="search"], input[name*="search"], input[name*="query"], input[name*="q"], input[placeholder*="Search" i], input[aria-label*="Search" i], [role="searchbox"]'
  ).first();

  try {
    await searchInput.fill(query);
    await page.keyboard.press("Enter");
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch { /* may not navigate */ }

    const delta = await getPageDelta(page);
    return {
      intent: `search for "${query}"`,
      success: true,
      description: `Searched for "${query}". ${delta.navigated ? `Navigated to ${delta.newUrl}` : "Results loaded on same page."}`,
      error: null,
      delta,
    };
  } catch {
    return {
      intent: `search for "${query}"`,
      success: false,
      description: "No search input found on this page.",
      error: "Could not find a search input (tried: type=search, name*=search/query/q, placeholder*=Search, aria-label*=Search, role=searchbox).",
      delta: null,
    };
  }
}

async function handleNavigate(page: Page, target: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const lower = target.toLowerCase();

  // Search nav components for matching link
  for (const comp of digest.components) {
    if (comp.type !== "nav" || !comp.items) continue;
    for (const item of comp.items) {
      if (item.text.toLowerCase().includes(lower) || lower.includes(item.text.toLowerCase())) {
        await page.goto(item.href, { waitUntil: "domcontentloaded" });
        const delta = await getPageDelta(page);
        return {
          intent: `navigate to "${target}"`,
          success: true,
          description: `Navigated to "${item.text}" (${item.href}).`,
          error: null,
          delta,
        };
      }
    }
  }

  // Try clicking a link with matching text anywhere on the page
  try {
    await page.getByRole("link", { name: target }).first().click();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
    } catch { /* may be SPA */ }

    const delta = await getPageDelta(page);
    return {
      intent: `navigate to "${target}"`,
      success: true,
      description: `Clicked link "${target}". ${delta.navigated ? `Now at ${delta.newUrl}` : "Page updated."}`,
      error: null,
      delta,
    };
  } catch {
    return {
      intent: `navigate to "${target}"`,
      success: false,
      description: `No link matching "${target}" found.`,
      error: `Available navigation: ${digest.components.filter((c) => c.type === "nav").flatMap((c) => c.items ?? []).map((i) => i.text).join(", ") || "none detected"}`,
      delta: null,
    };
  }
}

async function handleSubmitForm(page: Page, formName?: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const forms = digest.components.filter((c) => c.type === "form");

  let target = forms[0]; // Default to first form
  if (formName) {
    const lower = formName.toLowerCase();
    target = forms.find((f) => f.name.toLowerCase().includes(lower)) ?? forms[0];
  }

  if (!target) {
    return {
      intent: "submit form",
      success: false,
      description: "No form found on this page.",
      error: null,
      delta: null,
    };
  }

  if (target.actions.length > 0) {
    try {
      await page.getByRole("button", { name: target.actions[0] }).click();
    } catch {
      // Try locator by text
      await page.getByText(target.actions[0]!, { exact: false }).first().click();
    }
  } else {
    await page.locator(target.selector).locator('button[type="submit"], button:not([type]), input[type="submit"]').first().click();
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch { /* may not navigate */ }

  const delta = await getPageDelta(page);
  return {
    intent: `submit form "${target.name}"`,
    success: true,
    description: `Submitted "${target.name}". ${delta.navigated ? `Navigated to ${delta.newUrl}` : "Stayed on same page."}`,
    error: null,
    delta,
  };
}

async function handleFillForm(page: Page, _formName: string | undefined, dataStr: string): Promise<IntentResult> {
  // Parse "field: value, field2: value2" or "field: value"
  const pairs: [string, string][] = [];
  for (const part of dataStr.split(",")) {
    const match = part.match(/\s*(?:"|')?(.+?)(?:"|')?\s*:\s*(?:"|')?(.+?)(?:"|')?\s*$/);
    if (match) pairs.push([match[1]!, match[2]!]);
  }

  if (pairs.length === 0) {
    return {
      intent: "fill form",
      success: false,
      description: "Could not parse field data.",
      error: `Expected format: fill form with {field1: value1, field2: value2}. Got: {${dataStr}}`,
      delta: null,
    };
  }

  let filled = 0;
  for (const [field, value] of pairs) {
    try {
      // Try by label first, then placeholder, then name
      const loc = page.getByLabel(field, { exact: false }).first();
      if (await loc.isVisible({ timeout: 1000 })) {
        await loc.fill(value);
        filled++;
        continue;
      }
    } catch { /* try next */ }

    try {
      await page.getByPlaceholder(field, { exact: false }).first().fill(value);
      filled++;
      continue;
    } catch { /* try next */ }

    try {
      await page.locator(`[name="${field}"]`).fill(value);
      filled++;
    } catch { /* field not found */ }
  }

  const delta = await getPageDelta(page);
  return {
    intent: "fill form",
    success: filled === pairs.length,
    description: `Filled ${filled}/${pairs.length} fields.`,
    error: filled < pairs.length ? `${pairs.length - filled} field(s) not found` : null,
    delta,
  };
}

async function handleScroll(page: Page, target: string): Promise<IntentResult> {
  const digest = await getPageDigest(page);
  const lower = target.toLowerCase();

  // Find component by name
  const comp = digest.components.find((c) => c.name.toLowerCase().includes(lower));
  if (comp) {
    try {
      await page.locator(comp.selector).first().scrollIntoViewIfNeeded();
      const delta = await getPageDelta(page);
      return {
        intent: `scroll to "${target}"`,
        success: true,
        description: `Scrolled to "${comp.name}".`,
        error: null,
        delta,
      };
    } catch { /* fall through */ }
  }

  // Try scrolling to text
  try {
    await page.getByText(target, { exact: false }).first().scrollIntoViewIfNeeded();
    const delta = await getPageDelta(page);
    return {
      intent: `scroll to "${target}"`,
      success: true,
      description: `Scrolled to text "${target}".`,
      error: null,
      delta,
    };
  } catch {
    return {
      intent: `scroll to "${target}"`,
      success: false,
      description: `Could not find "${target}" to scroll to.`,
      error: `Available components: ${digest.components.map((c) => c.name).join(", ")}`,
      delta: null,
    };
  }
}

function cssEscape(value: string): string {
  return value.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "\\$&");
}

async function fillFieldByName(page: Page, name: string, value: string): Promise<void> {
  try {
    await page.locator(`[name="${cssEscape(name)}"]`).fill(value);
  } catch {
    try {
      await page.getByLabel(name, { exact: false }).first().fill(value);
    } catch {
      await page.locator(`#${cssEscape(name)}`).fill(value);
    }
  }
}
