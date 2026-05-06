import { describe, it, expect } from "vitest";
import { slugify, truncate, fuzzyMatch, levenshtein } from "../src/utils.js";

describe("slugify", () => {
  it("converts text to kebab-case slug", () => {
    expect(slugify("Homepage Loaded")).toBe("homepage-loaded");
  });

  it("removes special characters", () => {
    expect(slugify("Step 1: Click CTA!")).toBe("step-1-click-cta");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("---test---")).toBe("test");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates and adds ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });

  it("handles exact length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns length for empty string comparison", () => {
    expect(levenshtein("", "hello")).toBe(5);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("counts single substitution", () => {
    expect(levenshtein("cat", "car")).toBe(1);
  });

  it("counts single insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  it("counts single deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("handles complete difference", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("handles transposition", () => {
    // "ab" → "ba" = 2 (substitution × 2, not transposition)
    expect(levenshtein("ab", "ba")).toBe(2);
  });
});

describe("fuzzyMatch", () => {
  it("returns 1 for exact match", () => {
    expect(fuzzyMatch("Submit", "Submit")).toBe(1);
  });

  it("returns 1 for case-insensitive exact match", () => {
    expect(fuzzyMatch("submit", "Submit")).toBe(1);
  });

  it("returns 0.9 for containment (haystack contains needle)", () => {
    expect(fuzzyMatch("Sign In", "Sign In Button")).toBe(0.9);
  });

  it("returns 0.85 for reverse containment (needle contains haystack)", () => {
    expect(fuzzyMatch("Sign In Button", "Sign In")).toBe(0.85);
  });

  it("scores typos via edit distance", () => {
    const score = fuzzyMatch("Sbumit", "Submit");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(0.9);
  });

  it("scores similar words via edit distance", () => {
    const score = fuzzyMatch("Signin", "Sign In");
    expect(score).toBeGreaterThan(0.4);
  });

  it("returns 0 for completely different strings", () => {
    expect(fuzzyMatch("hello", "xyz")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(fuzzyMatch("", "hello")).toBe(0);
    expect(fuzzyMatch("hello", "")).toBe(0);
    expect(fuzzyMatch("", "")).toBe(0);
  });

  it("handles word overlap scoring", () => {
    const score = fuzzyMatch("create account", "Create New Account");
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores partial word matches", () => {
    const score = fuzzyMatch("Email", "Email Address");
    expect(score).toBeGreaterThan(0.8);
  });

  it("ranks exact match higher than partial", () => {
    const exact = fuzzyMatch("Login", "Login");
    const partial = fuzzyMatch("Login", "Login Button");
    expect(exact).toBeGreaterThan(partial);
  });

  it("ranks containment higher than typo", () => {
    const containment = fuzzyMatch("Sign", "Sign In");
    const typo = fuzzyMatch("Sgn", "Sign");
    expect(containment).toBeGreaterThan(typo);
  });
});
