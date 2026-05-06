import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../src/types.js";

describe("DEFAULTS", () => {
  it("has correct default values", () => {
    expect(DEFAULTS.outputDir).toBe(".agentlens");
    expect(DEFAULTS.maxElements).toBe(30);
    expect(DEFAULTS.maxTextLength).toBe(2000);
    expect(DEFAULTS.includeAria).toBe(false);
    expect(DEFAULTS.ariaDepth).toBe(3);
    expect(DEFAULTS.fullPage).toBe(false);
  });

  it("covers all AgentLensOptions keys", () => {
    const keys = Object.keys(DEFAULTS);
    expect(keys).toContain("outputDir");
    expect(keys).toContain("maxElements");
    expect(keys).toContain("maxTextLength");
    expect(keys).toContain("includeAria");
    expect(keys).toContain("ariaDepth");
    expect(keys).toContain("fullPage");
    expect(keys).toContain("actionTimeout");
    expect(keys).toContain("capturePerformance");
    expect(keys).toContain("captureStorage");
    expect(keys.length).toBe(9);
  });
});
