// Agent API
export { AgentPage } from "./agent/agent-page.js";
export { getPageDigest } from "./agent/digest.js";
export { getPageDelta, setBaseline, clearBaseline } from "./agent/delta.js";
export { detectComponents } from "./agent/components.js";
export { detectBlockers, detectStatus, waitUntilReady, dismissBlockers } from "./agent/blockers.js";
export { executeIntent } from "./agent/intent.js";

// Browser
export { Browser } from "./browser/browser.js";
export { BrowserPage } from "./browser/page.js";

// Configuration
export { loadConfig, resolveOptions, resetConfigCache } from "./config.js";

// Session
export { resetSession } from "./session.js";

// Snapshot
export { matchAgentSnapshot, updateAgentSnapshot, normalizeForSnapshot } from "./snapshot.js";

// Utilities
export { slugify, truncate, fuzzyMatch, levenshtein, cssEscape } from "./utils.js";

// Types
export type {
  ComponentType, FormField, NavItem, TableSummary, PageComponent,
  PageReadiness, PageBlocker, PageStatus, PageDigest, PageDelta,
  IntentResult, ContextBudget,
} from "./agent/types.js";
export { AGENT_DEFAULTS } from "./agent/types.js";

export type { LaunchOptions, BrowserProcess } from "./browser/launcher.js";
export type { ConsoleMessage, NetworkResponse } from "./browser/page.js";
