export interface AgentLensOptions {
  /** Directory for output files. Default: ".agentlens" */
  outputDir?: string;
  /** Max interactive elements to collect. Default: 30 */
  maxElements?: number;
  /** Max text length per element. Default: 2000 */
  maxTextLength?: number;
  /** Include ARIA snapshot in observations. Default: false */
  includeAria?: boolean;
  /** Depth for ARIA snapshot tree. Default: 3 */
  ariaDepth?: number;
  /** Take full-page screenshot instead of viewport. Default: false */
  fullPage?: boolean;
  /** Timeout in ms for act() to wait for elements. Default: 5000 */
  actionTimeout?: number;
  /** Capture performance metrics (LCP, CLS, TTFB). Default: false */
  capturePerformance?: boolean;
  /** Capture cookies and localStorage keys. Default: false */
  captureStorage?: boolean;
}

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InteractiveElement {
  tag: string;
  text: string;
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
  type: string | null;
  placeholder: string | null;
  name: string | null;
  href: string | null;
  rect: BoundingRect;
  visible: boolean;
}

export interface ConsoleError {
  message: string;
  count: number;
}

export interface PerformanceMetrics {
  /** Largest Contentful Paint in ms */
  lcp: number | null;
  /** Cumulative Layout Shift */
  cls: number | null;
  /** Time to First Byte in ms */
  ttfb: number | null;
  /** DOM Content Loaded in ms */
  domContentLoaded: number | null;
  /** Full page load in ms */
  load: number | null;
}

export interface StorageState {
  cookies: { name: string; domain: string; path: string; secure: boolean; httpOnly: boolean }[];
  localStorageKeys: string[];
  sessionStorageKeys: string[];
}

export interface VisibleState {
  url: string;
  title: string;
  viewportSize: { width: number; height: number };
  headings: { level: number; text: string }[];
  buttons: { text: string; ariaLabel: string | null; disabled: boolean }[];
  links: { text: string; href: string; ariaLabel: string | null }[];
  inputs: {
    type: string | null;
    name: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    label: string | null;
    value: string;
  }[];
  interactiveElements: InteractiveElement[];
  consoleErrors: ConsoleError[];
  failedRequests: { url: string; status: number; method: string }[];
  performance: PerformanceMetrics | null;
  storage: StorageState | null;
}

export interface StateDiff {
  urlChanged: boolean;
  titleChanged: boolean;
  newUrl?: string;
  oldUrl?: string;
  headingsAdded: string[];
  headingsRemoved: string[];
  buttonsAdded: string[];
  buttonsRemoved: string[];
  inputsAdded: string[];
  inputsRemoved: string[];
  newConsoleErrors: number;
  newFailedRequests: number;
}

export interface Observation {
  step: number;
  label: string;
  timestamp: string;
  screenshotPath: string | null;
  visibleState: VisibleState;
  ariaSnapshot: string | null;
  /** Diff from previous observation. Null for the first observation. */
  diff: StateDiff | null;
}

export interface ActionResult {
  action: string;
  target: string;
  success: boolean;
  error: string | null;
  element: Pick<InteractiveElement, "tag" | "text" | "role" | "ariaLabel"> | null;
}

export interface ObservationLog {
  startedAt: string;
  observations: Observation[];
}

export const DEFAULTS = {
  outputDir: ".agentlens",
  maxElements: 30,
  maxTextLength: 2000,
  includeAria: false,
  ariaDepth: 3,
  fullPage: false,
  actionTimeout: 5000,
  capturePerformance: false,
  captureStorage: false,
} as const satisfies Required<AgentLensOptions>;
