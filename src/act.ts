import type { Page } from "@playwright/test";
import type { ActionResult, AgentLensOptions, InteractiveElement } from "./types.js";
import { loadConfig, resolveOptions } from "./config.js";
import { getVisibleState } from "./visible-state.js";
import { fuzzyMatch, cssEscape } from "./utils.js";

/**
 * Execute a deterministic action on a page using a natural-language instruction.
 *
 * Supported patterns:
 * - "click primary CTA" — clicks the largest visible button/link above the fold
 * - "click [text]" — fuzzy-matches visible links/buttons
 * - "fill [field] with [value]" — fills an input
 * - "type [field] with [value]" — types character by character
 * - "select [option] in [field]" — selects from a dropdown
 * - "check [label]" / "uncheck [label]" — checkbox control
 * - "hover [text]" — hover over an element (for tooltips/menus)
 * - "press [key]" — press a keyboard key (Enter, Escape, Tab, etc.)
 *
 * Retries up to actionTimeout ms if the element isn't immediately available.
 * Throws if the instruction is ambiguous (returns top 5 candidates in the error).
 */
export async function act(
  page: Page,
  instruction: string,
  options?: AgentLensOptions
): Promise<ActionResult> {
  const fileConfig = await loadConfig();
  const opts = resolveOptions(options, fileConfig);
  const trimmed = instruction.trim();
  const normalized = trimmed.toLowerCase();

  // Match against normalized (for command detection) but capture from original (for values)
  const originalMatch = (pattern: RegExp) => trimmed.match(new RegExp(pattern.source, "i"));

  // "press [key]" — no element needed, just keyboard
  const pressMatch = originalMatch(/^press\s+(?:"|')?(.+?)(?:"|')?$/);
  if (pressMatch) {
    return pressKey(page, pressMatch[1]!);
  }

  if (normalized === "click primary cta") {
    return withRetry(() => clickPrimaryCTA(page, opts), opts.actionTimeout);
  }

  const selectMatch = originalMatch(
    /^select\s+(?:"|')?(.+?)(?:"|')?\s+(?:in|from)\s+(?:"|')?(.+?)(?:"|')?$/
  );
  if (selectMatch) {
    return withRetry(() => selectOption(page, selectMatch[2]!, selectMatch[1]!, opts), opts.actionTimeout);
  }

  const fillMatch = originalMatch(
    /^fill\s+(?:"|')?(.+?)(?:"|')?\s+with\s+(?:"|')?(.+?)(?:"|')?$/
  );
  if (fillMatch) {
    return withRetry(() => fillOrType(page, fillMatch[1]!, fillMatch[2]!, "fill", opts), opts.actionTimeout);
  }

  const typeMatch = originalMatch(
    /^type\s+(?:"|')?(.+?)(?:"|')?\s+with\s+(?:"|')?(.+?)(?:"|')?$/
  );
  if (typeMatch) {
    return withRetry(() => fillOrType(page, typeMatch[1]!, typeMatch[2]!, "type", opts), opts.actionTimeout);
  }

  const checkMatch = originalMatch(/^check\s+(?:"|')?(.+?)(?:"|')?$/);
  if (checkMatch) {
    return withRetry(() => checkBox(page, checkMatch[1]!, true, opts), opts.actionTimeout);
  }

  const uncheckMatch = originalMatch(/^uncheck\s+(?:"|')?(.+?)(?:"|')?$/);
  if (uncheckMatch) {
    return withRetry(() => checkBox(page, uncheckMatch[1]!, false, opts), opts.actionTimeout);
  }

  const hoverMatch = originalMatch(/^hover\s+(?:"|')?(.+?)(?:"|')?$/);
  if (hoverMatch) {
    return withRetry(() => hoverByText(page, hoverMatch[1]!, opts), opts.actionTimeout);
  }

  const clickMatch = originalMatch(/^click\s+(?:"|')?(.+?)(?:"|')?$/);
  if (clickMatch) {
    return withRetry(() => clickByText(page, clickMatch[1]!, opts), opts.actionTimeout);
  }

  return {
    action: "unknown",
    target: instruction,
    success: false,
    error: `Unrecognized instruction: "${instruction}". Supported: "click [text]", "click primary CTA", "fill [field] with [value]", "type [field] with [value]", "select [option] in [field]", "check [label]", "uncheck [label]", "hover [text]", "press [key]".`,
    element: null,
  };
}

// --- Retry wrapper ---

async function withRetry(
  fn: () => Promise<ActionResult>,
  timeoutMs: number,
): Promise<ActionResult> {
  const start = Date.now();
  let lastResult: ActionResult | null = null;

  while (Date.now() - start < timeoutMs) {
    lastResult = await fn();
    if (lastResult.success) return lastResult;
    // If the error is ambiguity, don't retry — it won't resolve itself
    if (lastResult.error?.includes("Ambiguous")) return lastResult;
    // If it's an "unrecognized" error, don't retry
    if (lastResult.action === "unknown") return lastResult;
    // Wait briefly before retrying
    await new Promise((r) => setTimeout(r, 250));
  }

  return lastResult ?? {
    action: "retry",
    target: "",
    success: false,
    error: `Timed out after ${timeoutMs}ms`,
    element: null,
  };
}

// --- Actions ---

async function pressKey(page: Page, key: string): Promise<ActionResult> {
  // Normalize common key names
  const keyMap: Record<string, string> = {
    enter: "Enter",
    escape: "Escape",
    esc: "Escape",
    tab: "Tab",
    space: " ",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    "up": "ArrowUp",
    "down": "ArrowDown",
    "left": "ArrowLeft",
    "right": "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  };

  const resolved = keyMap[key.toLowerCase()] ?? key;

  try {
    await page.keyboard.press(resolved);
    return {
      action: "press",
      target: resolved,
      success: true,
      error: null,
      element: null,
    };
  } catch (err) {
    return {
      action: "press",
      target: resolved,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      element: null,
    };
  }
}

async function clickPrimaryCTA(
  page: Page,
  opts: Required<AgentLensOptions>
): Promise<ActionResult> {
  const state = await getVisibleState(page, opts);
  const viewport = state.viewportSize;

  const candidates = state.interactiveElements
    .filter((el) => {
      const isClickable =
        el.tag === "button" || el.tag === "a" || el.role === "button" || el.role === "link";
      const aboveFold = el.rect.y + el.rect.height <= viewport.height;
      return isClickable && aboveFold && el.visible;
    })
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

  if (candidates.length === 0) {
    return {
      action: "click",
      target: "primary CTA",
      success: false,
      error: "No clickable elements found above the fold.",
      element: null,
    };
  }

  return clickElement(page, candidates[0]!, "click primary CTA");
}

async function clickByText(
  page: Page,
  text: string,
  opts: Required<AgentLensOptions>
): Promise<ActionResult> {
  const state = await getVisibleState(page, opts);
  const clickable = state.interactiveElements.filter((el) =>
    ["button", "a"].includes(el.tag) ||
    ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch"].includes(el.role ?? "")
  );

  const scored = scoreElements(text, clickable);
  if (scored.length === 0) {
    return {
      action: "click",
      target: text,
      success: false,
      error: `No clickable element matching "${text}". ${formatCandidates(clickable)}`,
      element: null,
    };
  }

  assertUnambiguous(text, "click", scored);
  return clickElement(page, scored[0]!.el, `click "${text}"`);
}

async function hoverByText(
  page: Page,
  text: string,
  opts: Required<AgentLensOptions>
): Promise<ActionResult> {
  const state = await getVisibleState(page, opts);
  const scored = scoreElements(text, state.interactiveElements);

  if (scored.length === 0) {
    return {
      action: "hover",
      target: text,
      success: false,
      error: `No element matching "${text}" to hover. ${formatCandidates(state.interactiveElements)}`,
      element: null,
    };
  }

  assertUnambiguous(text, "hover", scored);
  const el = scored[0]!.el;

  try {
    if (el.testId) {
      await page.getByTestId(el.testId).hover();
    } else if (el.text) {
      await page.getByText(el.text, { exact: false }).first().hover();
    } else if (el.ariaLabel) {
      await page.getByLabel(el.ariaLabel).hover();
    } else {
      const x = el.rect.x + el.rect.width / 2;
      const y = el.rect.y + el.rect.height / 2;
      await page.mouse.move(x, y);
    }
    return {
      action: "hover",
      target: el.text || el.ariaLabel || el.tag,
      success: true,
      error: null,
      element: { tag: el.tag, text: el.text, role: el.role, ariaLabel: el.ariaLabel },
    };
  } catch (err) {
    return {
      action: "hover",
      target: el.text || el.ariaLabel || el.tag,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      element: { tag: el.tag, text: el.text, role: el.role, ariaLabel: el.ariaLabel },
    };
  }
}

async function fillOrType(
  page: Page,
  fieldName: string,
  value: string,
  mode: "fill" | "type",
  opts: Required<AgentLensOptions>
): Promise<ActionResult> {
  const state = await getVisibleState(page, opts);

  const scored = state.inputs
    .map((input) => {
      const candidates = [
        input.label ?? "",
        input.placeholder ?? "",
        input.name ?? "",
        input.ariaLabel ?? "",
      ].filter(Boolean);
      const score = Math.max(0, ...candidates.map((c) => fuzzyMatch(fieldName, c)));
      return { input, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      action: mode,
      target: fieldName,
      success: false,
      error: `No input matching "${fieldName}". Found ${state.inputs.length} inputs: ${state.inputs
        .slice(0, 5)
        .map((i) => `[${i.type ?? "input"}] ${i.label || i.placeholder || i.name || "(no label)"}`)
        .join(", ")}`,
      element: null,
    };
  }

  if (scored.length >= 2 && scored[1]!.score > 0.8 && scored[0]!.score - scored[1]!.score < 0.05) {
    const top5 = scored.slice(0, 5);
    return {
      action: mode,
      target: fieldName,
      success: false,
      error: `Ambiguous ${mode} target "${fieldName}". Top ${top5.length} candidates:\n` +
        top5.map((s, i) => `  ${i + 1}. [${s.input.type ?? "input"}] "${s.input.label || s.input.placeholder || s.input.name}" (score: ${s.score.toFixed(2)})`).join("\n"),
      element: null,
    };
  }

  const best = scored[0]!.input;
  try {
    const locator = resolveInputLocator(page, best);
    if (!locator) {
      return {
        action: mode,
        target: fieldName,
        success: false,
        error: `Found input but could not determine a locator. Input: [${best.type}] label=${best.label}, placeholder=${best.placeholder}, name=${best.name}`,
        element: null,
      };
    }

    if (mode === "type") {
      await locator.click();
      await locator.pressSequentially(value, { delay: 50 });
    } else {
      await locator.fill(value);
    }

    return {
      action: mode,
      target: fieldName,
      success: true,
      error: null,
      element: {
        tag: best.type ?? "input",
        text: best.label ?? best.placeholder ?? "",
        role: null,
        ariaLabel: best.ariaLabel,
      },
    };
  } catch (err) {
    return {
      action: mode,
      target: fieldName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      element: null,
    };
  }
}

async function selectOption(
  page: Page,
  fieldName: string,
  optionText: string,
  opts: Required<AgentLensOptions>
): Promise<ActionResult> {
  const state = await getVisibleState(page, opts);
  const selects = state.inputs.filter(
    (i) => i.type === "select-one" || i.type === "select-multiple" || i.type === "select" || i.type === "SELECT"
  );

  const scored = selects
    .map((input) => {
      const candidates = [input.label ?? "", input.placeholder ?? "", input.name ?? "", input.ariaLabel ?? ""].filter(Boolean);
      const score = Math.max(0, ...candidates.map((c) => fuzzyMatch(fieldName, c)));
      return { input, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      action: "select",
      target: fieldName,
      success: false,
      error: `No select element matching "${fieldName}". Found ${selects.length} selects.`,
      element: null,
    };
  }

  const best = scored[0]!.input;
  try {
    // For selects, prefer name-based locator since getByLabel can be flaky with selects
    const locator = best.name
      ? page.locator(`select[name="${cssEscape(best.name)}"]`)
      : resolveInputLocator(page, best);
    if (!locator) {
      return { action: "select", target: fieldName, success: false, error: `Found select but could not determine a locator.`, element: null };
    }
    await locator.selectOption({ label: optionText });
    return {
      action: "select",
      target: `${optionText} in ${fieldName}`,
      success: true,
      error: null,
      element: { tag: "select", text: best.label ?? best.name ?? "", role: null, ariaLabel: best.ariaLabel },
    };
  } catch (err) {
    return {
      action: "select",
      target: fieldName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      element: null,
    };
  }
}

async function checkBox(
  page: Page,
  labelText: string,
  checked: boolean,
  opts: Required<AgentLensOptions>
): Promise<ActionResult> {
  const action = checked ? "check" : "uncheck";

  // Try direct Playwright getByLabel first — it handles wrapped checkboxes well
  try {
    const loc = page.getByLabel(labelText, { exact: false });
    if (await loc.count() > 0) {
      if (checked) await loc.first().check(); else await loc.first().uncheck();
      return { action, target: labelText, success: true, error: null, element: { tag: "input", text: labelText, role: "checkbox", ariaLabel: null } };
    }
  } catch {
    // Fall through to manual search
  }

  // Fallback: also try matching against inputs that have matching labels
  const state = await getVisibleState(page, opts);
  const checkboxInputs = state.inputs.filter(
    (i) => i.type === "checkbox"
  );

  const scoredInputs = checkboxInputs
    .map((input) => {
      const candidates = [input.label ?? "", input.ariaLabel ?? "", input.name ?? ""].filter(Boolean);
      const score = Math.max(0, ...candidates.map((c) => fuzzyMatch(labelText, c)));
      return { input, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredInputs.length > 0) {
    const best = scoredInputs[0]!.input;
    try {
      const loc = resolveInputLocator(page, best);
      if (loc) {
        if (checked) await loc.check(); else await loc.uncheck();
        return { action, target: labelText, success: true, error: null, element: { tag: "input", text: best.label ?? "", role: "checkbox", ariaLabel: best.ariaLabel } };
      }
    } catch (err) {
      return { action, target: labelText, success: false, error: err instanceof Error ? err.message : String(err), element: null };
    }
  }

  // Last resort: match against interactive elements
  const checkable = state.interactiveElements.filter(
    (el) => el.role === "checkbox" || el.role === "switch" || el.type === "checkbox"
  );
  const scored = scoreElements(labelText, checkable);
  if (scored.length === 0) {
    return { action, target: labelText, success: false, error: `No checkbox matching "${labelText}". ${formatCandidates(checkable)}`, element: null };
  }

  const el = scored[0]!.el;
  try {
    if (el.testId) {
      const loc = page.getByTestId(el.testId);
      if (checked) await loc.check(); else await loc.uncheck();
    } else {
      const x = el.rect.x + el.rect.width / 2;
      const y = el.rect.y + el.rect.height / 2;
      await page.mouse.click(x, y);
    }
    return { action, target: labelText, success: true, error: null, element: { tag: el.tag, text: el.text, role: el.role, ariaLabel: el.ariaLabel } };
  } catch (err) {
    return { action, target: labelText, success: false, error: err instanceof Error ? err.message : String(err), element: { tag: el.tag, text: el.text, role: el.role, ariaLabel: el.ariaLabel } };
  }
}

// --- Shared helpers ---

function scoreElements(text: string, elements: InteractiveElement[]) {
  return elements
    .map((el) => ({
      el,
      score: Math.max(
        fuzzyMatch(text, el.text),
        el.ariaLabel ? fuzzyMatch(text, el.ariaLabel) : 0,
        el.testId ? fuzzyMatch(text, el.testId) : 0,
      ),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

function assertUnambiguous(text: string, action: string, scored: { el: InteractiveElement; score: number }[]): void {
  if (scored.length >= 2 && scored[1]!.score > 0.8 && scored[0]!.score - scored[1]!.score < 0.05) {
    const top5 = scored.slice(0, 5);
    throw new Error(
      `Ambiguous ${action} target "${text}". Top ${top5.length} candidates:\n` +
      top5.map((s, i) => `  ${i + 1}. <${s.el.tag}> "${s.el.text}" (score: ${s.score.toFixed(2)}, aria: ${s.el.ariaLabel ?? "none"})`).join("\n")
    );
  }
}

function formatCandidates(elements: InteractiveElement[]): string {
  if (elements.length === 0) return "No interactive elements found.";
  return `Found ${elements.length} elements: ${elements.slice(0, 5).map((e) => `<${e.tag}>${e.text || e.ariaLabel || "(no text)"}</${e.tag}>`).join(", ")}`;
}

type InputInfo = { type: string | null; name: string | null; placeholder: string | null; ariaLabel: string | null; label: string | null };

function resolveInputLocator(page: Page, input: InputInfo) {
  if (input.ariaLabel) return page.getByLabel(input.ariaLabel);
  if (input.label) return page.getByLabel(input.label);
  if (input.placeholder) return page.getByPlaceholder(input.placeholder);
  if (input.name) return page.locator(`[name="${cssEscape(input.name)}"]`);
  return null;
}

async function clickElement(page: Page, el: InteractiveElement, action: string): Promise<ActionResult> {
  try {
    if (el.testId) {
      await page.getByTestId(el.testId).click();
    } else if (el.role && el.ariaLabel) {
      await page.getByRole(el.role as Parameters<Page["getByRole"]>[0], { name: el.ariaLabel }).click();
    } else if (el.role && el.text) {
      await page.getByRole(el.role as Parameters<Page["getByRole"]>[0], { name: el.text }).click();
    } else if (el.text) {
      await page.getByText(el.text, { exact: false }).first().click();
    } else if (el.ariaLabel) {
      await page.getByLabel(el.ariaLabel).click();
    } else {
      const x = el.rect.x + el.rect.width / 2;
      const y = el.rect.y + el.rect.height / 2;
      await page.mouse.click(x, y);
    }
    return { action, target: el.text || el.ariaLabel || el.tag, success: true, error: null, element: { tag: el.tag, text: el.text, role: el.role, ariaLabel: el.ariaLabel } };
  } catch (err) {
    return { action, target: el.text || el.ariaLabel || el.tag, success: false, error: err instanceof Error ? err.message : String(err), element: { tag: el.tag, text: el.text, role: el.role, ariaLabel: el.ariaLabel } };
  }
}
