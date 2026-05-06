// Core API
export { observe, observeResponsive } from "./observe.js";
export { getVisibleState, setupListeners, drainErrors } from "./visible-state.js";
export { act } from "./act.js";
export { uxReport, uxReportHtml } from "./ux-report.js";

// Session management
export { resetSession } from "./session.js";

// Multi-tab
export { observeAllTabs, waitForNewTab } from "./multi-tab.js";

// Configuration
export { loadConfig, resolveOptions, resetConfigCache } from "./config.js";

// Snapshot testing
export { matchAgentSnapshot, updateAgentSnapshot, normalizeForSnapshot } from "./snapshot.js";

// Accessibility
export { auditAccessibility, formatA11yReport } from "./a11y.js";
export type { A11yViolation } from "./a11y.js";

// Types
export type {
  AgentLensOptions,
  InteractiveElement,
  VisibleState,
  Observation,
  ActionResult,
  BoundingRect,
  ObservationLog,
  StateDiff,
  ConsoleError,
  PerformanceMetrics,
  StorageState,
} from "./types.js";

export { DEFAULTS } from "./types.js";
