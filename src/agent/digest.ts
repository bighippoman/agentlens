import type { BrowserPage } from "../browser/page.js";
import type { ContextBudget, PageComponent, PageDigest } from "./types.js";
import { AGENT_DEFAULTS } from "./types.js";
import { detectComponents } from "./components.js";
import { detectStatus } from "./blockers.js";

/**
 * Get a compact, semantic digest of the current page state.
 *
 * Returns structured components + a text digest designed to be
 * dropped directly into an AI agent's context window.
 * Target: < 500 tokens for most pages.
 */
export async function getPageDigest(
  page: BrowserPage,
  budget?: Partial<ContextBudget>
): Promise<PageDigest> {
  const maxTokens = budget?.maxTokens ?? AGENT_DEFAULTS.contextBudget.maxTokens;
  const priority = budget?.priority ?? AGENT_DEFAULTS.contextBudget.priority;

  // Wait briefly for DOM to settle
  try {
    await page.waitForLoad(3000);
  } catch { /* collect whatever is available */ }

  const [url, title, components, status] = await Promise.all([
    Promise.resolve(page.url()),
    page.title(),
    detectComponents(page),
    detectStatus(page),
  ]);

  const suggestedAction = computeSuggestedAction(components, status);
  const availableActions = computeAvailableActions(components);

  const text = renderDigest(
    url, title, components, status, suggestedAction, availableActions, maxTokens, priority
  );
  const tokens = estimateTokens(text);

  return {
    url,
    title,
    components,
    status,
    suggestedAction,
    availableActions,
    text,
    tokens,
  };
}

function computeSuggestedAction(
  components: PageComponent[],
  status: ReturnType<typeof detectStatus> extends Promise<infer T> ? T : never
): string | null {
  // Priority 1: Dismiss blockers
  const dismissable = status.blockers.filter((b) => b.dismissable);
  if (dismissable.length > 0) {
    const first = dismissable[0]!;
    if (first.type === "cookie-banner") return "dismiss cookie banner";
    return `dismiss ${first.type}: "${first.description}"`;
  }

  // Priority 2: Handle non-dismissable blockers
  if (status.readiness === "loading") return "wait for page to finish loading";
  if (status.readiness === "blocked") return "a modal or overlay is blocking — cannot interact until resolved";

  // Priority 3: Fill empty required form fields
  const form = components.find((c) => c.type === "form" && c.fields?.some((f) => f.required && f.empty));
  if (form) {
    const emptyRequired = form.fields!.filter((f) => f.required && f.empty);
    return `fill ${emptyRequired.length} required field(s) in "${form.name}": ${emptyRequired.map((f) => f.label).join(", ")}`;
  }

  // Priority 4: Submit filled form
  const readyForm = components.find(
    (c) => c.type === "form" && c.fields && c.fields.length > 0 && c.fields.every((f) => !f.required || !f.empty)
  );
  if (readyForm && readyForm.actions.length > 0) {
    return `form "${readyForm.name}" is ready — submit with "${readyForm.actions[0]}"`;
  }

  // Priority 5: Click primary CTA
  const hero = components.find((c) => c.type === "hero" && c.actions.length > 0);
  if (hero) return `click "${hero.actions[0]}" in hero section`;

  return null;
}

function computeAvailableActions(components: PageComponent[]): string[] {
  const actions: string[] = [];

  for (const c of components) {
    switch (c.type) {
      case "form":
        if (c.fields?.some((f) => f.empty)) actions.push(`fill "${c.name}" form`);
        if (c.actions.length > 0) actions.push(`submit "${c.name}" form`);
        break;
      case "nav":
        for (const item of c.items ?? []) {
          if (!item.active) actions.push(`navigate to "${item.text}"`);
        }
        break;
      case "hero":
        for (const a of c.actions) actions.push(`click "${a}"`);
        break;
      case "modal":
      case "toast":
        if (c.actions.length > 0) actions.push(`click "${c.actions[0]}" in ${c.type}`);
        break;
    }
    if (actions.length >= 15) break;
  }

  return actions;
}

function renderDigest(
  url: string,
  title: string,
  components: PageComponent[],
  status: Awaited<ReturnType<typeof detectStatus>>,
  suggestedAction: string | null,
  availableActions: string[],
  maxTokens: number,
  priority: readonly string[]
): string {
  const lines: string[] = [];

  lines.push(`Page: ${title} (${url})`);
  lines.push(`Status: ${status.readiness}${status.blockers.length > 0 ? ` — ${status.blockers.length} blocker(s)` : ""}`);

  if (suggestedAction) {
    lines.push(`Suggested: ${suggestedAction}`);
  }
  lines.push("");

  // Render components by priority
  const typeMap: Record<string, PageComponent[]> = {};
  for (const c of components) {
    const key = c.type === "modal" || c.type === "toast" || c.type === "cookie-banner" as string ? "blockers" : c.type;
    if (!typeMap[key]) typeMap[key] = [];
    typeMap[key]!.push(c);
  }

  const renderOrder = [...priority] as string[];
  // Add any types not in priority
  for (const key of Object.keys(typeMap)) {
    if (!renderOrder.includes(key)) renderOrder.push(key);
  }

  for (const key of renderOrder) {
    const group = typeMap[key];
    if (!group || group.length === 0) continue;

    for (const c of group) {
      lines.push(renderComponent(c));
    }

    // Check token budget
    const current = estimateTokens(lines.join("\n"));
    if (current > maxTokens * 0.8) {
      lines.push("... (truncated to fit context budget)");
      break;
    }
  }

  if (availableActions.length > 0) {
    lines.push("");
    lines.push(`Actions: ${availableActions.slice(0, 8).join(" | ")}`);
  }

  return lines.join("\n");
}

function renderComponent(c: PageComponent): string {
  const prefix = `[${c.type}]`;

  switch (c.type) {
    case "form":
      if (c.fields && c.fields.length > 0) {
        const fieldLines = c.fields.map((f) => {
          const status = f.empty ? "empty" : `"${f.value}"`;
          const req = f.required ? " *" : "";
          return `    ${f.label}${req}: ${status}`;
        });
        return `${prefix} ${c.name}: ${c.summary}\n${fieldLines.join("\n")}`;
      }
      return `${prefix} ${c.name}: ${c.summary}`;

    case "nav":
      if (c.items && c.items.length > 0) {
        const links = c.items.map((i) => i.active ? `[${i.text}]` : i.text);
        return `${prefix} ${c.name}: ${links.join(", ")}`;
      }
      return `${prefix} ${c.name}: ${c.summary}`;

    case "table":
      if (c.table) {
        let line = `${prefix} ${c.name}: ${c.table.columns.join(", ")} (${c.table.rowCount} rows)`;
        if (c.table.sampleRow) {
          line += `\n    Sample: ${c.table.sampleRow.join(" | ")}`;
        }
        return line;
      }
      return `${prefix} ${c.name}: ${c.summary}`;

    case "modal":
    case "toast":
      const blocking = c.blocking ? " (BLOCKING)" : "";
      const dismiss = c.actions.length > 0 ? ` → "${c.actions[0]}"` : "";
      return `${prefix} ${c.name}${blocking}: ${c.summary}${dismiss}`;

    default:
      if (c.actions.length > 0) {
        return `${prefix} ${c.name}: ${c.summary} → ${c.actions.map((a) => `"${a}"`).join(", ")}`;
      }
      return `${prefix} ${c.name}: ${c.summary}`;
  }
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}
