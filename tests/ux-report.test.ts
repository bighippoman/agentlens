import { describe, it, expect } from "vitest";
import { generateMarkdownReport } from "../src/ux-report.js";
import type { ObservationLog, VisibleState } from "../src/types.js";

function makeVisibleState(overrides: Partial<VisibleState> = {}): VisibleState {
  return {
    url: "https://example.com",
    title: "Example",
    viewportSize: { width: 1280, height: 720 },
    headings: [],
    buttons: [],
    links: [],
    inputs: [],
    interactiveElements: [],
    consoleErrors: [],
    failedRequests: [],
    performance: null,
    storage: null,
    ...overrides,
  };
}

function makeLog(observations: ObservationLog["observations"] = []): ObservationLog {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    observations,
  };
}

describe("generateMarkdownReport", () => {
  it("generates empty report for no observations", () => {
    const md = generateMarkdownReport(makeLog());
    expect(md).toContain("# AgentLens UX Report");
    expect(md).toContain("Total observations: 0");
    expect(md).toContain("## Context Avoided");
  });

  it("includes journey steps", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Homepage",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: ".agentlens/screenshots/001-homepage.png",
          visibleState: makeVisibleState(),
          ariaSnapshot: null,
          diff: null,
        },
      ])
    );
    expect(md).toContain("### Step 1: Homepage");
    expect(md).toContain("001-homepage.png");
  });

  it("includes current state with headings", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Test",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({
            headings: [
              { level: 1, text: "Welcome" },
              { level: 2, text: "Features" },
            ],
          }),
          ariaSnapshot: null,
          diff: null,
        },
      ])
    );
    expect(md).toContain("H1: Welcome");
    expect(md).toContain("H2: Features");
  });

  it("includes buttons with accessibility warnings", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Test",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({
            buttons: [
              { text: "Submit", ariaLabel: null, disabled: false },
              { text: "", ariaLabel: null, disabled: false },
            ],
          }),
          ariaSnapshot: null,
          diff: null,
        },
      ])
    );
    expect(md).toContain("Submit");
    expect(md).toContain("missing label!");
    expect(md).toContain("1 button(s) have no text or aria-label");
  });

  it("includes form completion analysis", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Test",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({
            inputs: [
              { type: "text", name: "email", placeholder: "Email", ariaLabel: null, label: "Email", value: "test@test.com" },
              { type: "password", name: "password", placeholder: "Password", ariaLabel: null, label: "Password", value: "" },
            ],
          }),
          ariaSnapshot: null,
          diff: null,
        },
      ])
    );
    expect(md).toContain("1/2 fields filled (50%)");
  });

  it("includes state diff information", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Before",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({ url: "https://example.com" }),
          ariaSnapshot: null,
          diff: null,
        },
        {
          step: 2,
          label: "After",
          timestamp: "2026-01-01T00:00:02.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({ url: "https://example.com/dashboard" }),
          ariaSnapshot: null,
          diff: {
            urlChanged: true,
            titleChanged: false,
            oldUrl: "https://example.com",
            newUrl: "https://example.com/dashboard",
            headingsAdded: ["H1: Dashboard"],
            headingsRemoved: ["H1: Welcome"],
            buttonsAdded: [],
            buttonsRemoved: [],
            inputsAdded: [],
            inputsRemoved: [],
            newConsoleErrors: 0,
            newFailedRequests: 0,
          },
        },
      ])
    );
    expect(md).toContain("URL changed");
    expect(md).toContain("New headings: H1: Dashboard");
    expect(md).toContain("Removed headings: H1: Welcome");
  });

  it("includes heading hierarchy warnings", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Test",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({
            headings: [
              { level: 2, text: "No H1 here" },
              { level: 4, text: "Skipped H3" },
            ],
          }),
          ariaSnapshot: null,
          diff: null,
        },
      ])
    );
    expect(md).toContain("No H1 found");
    expect(md).toContain("Heading level skip detected");
  });

  it("includes console errors and failed requests", () => {
    const md = generateMarkdownReport(
      makeLog([
        {
          step: 1,
          label: "Test",
          timestamp: "2026-01-01T00:00:01.000Z",
          screenshotPath: null,
          visibleState: makeVisibleState({
            consoleErrors: [{ message: "TypeError: undefined is not a function", count: 1 }],
            failedRequests: [{ url: "https://api.example.com/data", status: 500, method: "GET" }],
          }),
          ariaSnapshot: null,
          diff: null,
        },
      ])
    );
    expect(md).toContain("TypeError: undefined is not a function");
    expect(md).toContain("GET https://api.example.com/data");
    expect(md).toContain("500");
  });

  it("includes context avoided section", () => {
    const md = generateMarkdownReport(makeLog());
    expect(md).toContain("page.content()");
    expect(md).toContain("never captured");
    expect(md).toContain("Trace file contents");
    expect(md).toContain("Video file contents");
  });
});
