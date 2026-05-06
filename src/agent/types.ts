// ── Component types ──

export type ComponentType =
  | "nav"
  | "form"
  | "modal"
  | "toast"
  | "hero"
  | "card"
  | "card-list"
  | "table"
  | "media"
  | "footer"
  | "sidebar"
  | "content"
  | "unknown";

export interface FormField {
  name: string;
  type: string;
  label: string;
  value: string;
  required: boolean;
  empty: boolean;
  invalid: boolean;
}

export interface NavItem {
  text: string;
  href: string;
  active: boolean;
}

export interface TableSummary {
  columns: string[];
  rowCount: number;
  sampleRow: string[] | null;
}

export interface PageComponent {
  /** Semantic type of this component */
  type: ComponentType;
  /** Human/agent-readable name: "Login Form", "Main Navigation", "Cookie Banner" */
  name: string;
  /** One-line summary: "3 fields (email filled, password empty, name empty), submit disabled" */
  summary: string;
  /** For forms: structured field data */
  fields?: FormField[];
  /** For navs: link items */
  items?: NavItem[];
  /** For tables: column/row summary */
  table?: TableSummary;
  /** For modals/toasts: whether it's blocking interaction */
  blocking?: boolean;
  /** Actionable elements inside this component */
  actions: string[];
  /** Selector hint for targeting this component */
  selector: string;
}

// ── Page status ──

export type PageReadiness = "ready" | "loading" | "blocked" | "error";

export interface PageBlocker {
  type: "modal" | "dialog" | "overlay" | "spinner" | "toast" | "cookie-banner";
  description: string;
  dismissable: boolean;
  selector: string;
}

export interface PageStatus {
  readiness: PageReadiness;
  blockers: PageBlocker[];
  pendingNetwork: number;
  hasSpinner: boolean;
  consoleErrors: number;
  failedRequests: number;
}

// ── Page digest ──

export interface PageDigest {
  /** Current URL */
  url: string;
  /** Page title */
  title: string;
  /** Semantic components on the page */
  components: PageComponent[];
  /** Current page readiness and blockers */
  status: PageStatus;
  /** What the agent should probably do next */
  suggestedAction: string | null;
  /** Alternative actions available */
  availableActions: string[];
  /** Compact text digest for direct context insertion */
  text: string;
  /** Approximate token count of the text digest */
  tokens: number;
}

// ── Delta ──

export interface PageDelta {
  /** Whether the URL changed */
  navigated: boolean;
  /** New URL if navigated */
  newUrl?: string;
  /** Components that appeared since last digest */
  added: { type: ComponentType; name: string; summary: string }[];
  /** Components that disappeared */
  removed: { type: ComponentType; name: string }[];
  /** Components whose state changed (e.g., form field filled) */
  changed: { name: string; change: string }[];
  /** New blockers that appeared */
  newBlockers: PageBlocker[];
  /** Blockers that were dismissed */
  resolvedBlockers: string[];
  /** New console errors since last digest */
  newErrors: number;
  /** Whether anything actually changed */
  unchanged: boolean;
  /** Compact text delta for context insertion */
  text: string;
  /** Approximate token count */
  tokens: number;
}

// ── Intent actions ──

export interface IntentResult {
  /** What was attempted */
  intent: string;
  /** Whether it succeeded */
  success: boolean;
  /** What actually happened */
  description: string;
  /** Error message if failed */
  error: string | null;
  /** Page state after the action (delta from before) */
  delta: PageDelta | null;
}

// ── Context budget ──

export interface ContextBudget {
  /** Max tokens for digest output */
  maxTokens: number;
  /** Priority order for what to include when over budget */
  priority: ("errors" | "blockers" | "forms" | "nav" | "content" | "tables")[];
}

export const AGENT_DEFAULTS = {
  contextBudget: {
    maxTokens: 500,
    priority: ["errors", "blockers", "forms", "nav", "content", "tables"] as const,
  },
} as const;
