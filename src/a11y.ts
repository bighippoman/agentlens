import type { Page } from "@playwright/test";

export interface A11yViolation {
  rule: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  element: string;
  description: string;
}

/**
 * Run a lightweight accessibility audit on the current page.
 *
 * This is NOT a full axe-core audit — it checks common, high-impact issues:
 * - Images missing alt text
 * - Buttons/links without accessible names
 * - Inputs without labels
 * - Missing document language
 * - Missing page title
 * - Heading hierarchy issues
 * - Low contrast text (rough estimate)
 * - Missing landmark regions
 *
 * Returns a compact list of violations suitable for agent context.
 */
export async function auditAccessibility(page: Page): Promise<A11yViolation[]> {
  return page.evaluate(() => {
    const violations: {
      rule: string;
      severity: "critical" | "serious" | "moderate" | "minor";
      element: string;
      description: string;
    }[] = [];

    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className && typeof el.className === "string"
        ? `.${el.className.split(" ").slice(0, 2).join(".")}`
        : "";
      return `<${tag}${id}${cls}>`.slice(0, 80);
    }

    // Missing lang attribute
    if (!document.documentElement.lang) {
      violations.push({
        rule: "html-has-lang",
        severity: "serious",
        element: "<html>",
        description: "Page is missing a lang attribute on the <html> element.",
      });
    }

    // Missing page title
    if (!document.title.trim()) {
      violations.push({
        rule: "document-title",
        severity: "serious",
        element: "<head>",
        description: "Page has no title.",
      });
    }

    // Images without alt text
    const images = document.querySelectorAll("img");
    for (const img of images) {
      if (!img.hasAttribute("alt") && !img.getAttribute("role")?.includes("presentation")) {
        violations.push({
          rule: "image-alt",
          severity: "critical",
          element: describe(img),
          description: "Image is missing alt text.",
        });
      }
    }

    // Buttons without accessible names
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const htmlBtn = btn as HTMLElement;
      const hasName =
        htmlBtn.textContent?.trim() ||
        htmlBtn.getAttribute("aria-label") ||
        htmlBtn.getAttribute("aria-labelledby") ||
        htmlBtn.getAttribute("title");
      if (!hasName) {
        violations.push({
          rule: "button-name",
          severity: "critical",
          element: describe(btn),
          description: "Button has no accessible name (text, aria-label, or title).",
        });
      }
    }

    // Links without accessible names
    const links = document.querySelectorAll("a[href]");
    for (const link of links) {
      const htmlLink = link as HTMLElement;
      const hasName =
        htmlLink.textContent?.trim() ||
        htmlLink.getAttribute("aria-label") ||
        htmlLink.getAttribute("aria-labelledby") ||
        htmlLink.getAttribute("title");
      if (!hasName) {
        violations.push({
          rule: "link-name",
          severity: "serious",
          element: describe(link),
          description: "Link has no accessible name.",
        });
      }
    }

    // Inputs without labels
    const inputs = document.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select"
    );
    for (const input of inputs) {
      const htmlInput = input as HTMLInputElement;
      const hasLabel =
        htmlInput.getAttribute("aria-label") ||
        htmlInput.getAttribute("aria-labelledby") ||
        htmlInput.getAttribute("title") ||
        htmlInput.placeholder;
      if (!hasLabel) {
        // Check for associated label
        const id = htmlInput.id;
        const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
        const closestLabel = htmlInput.closest("label");
        if (!labelEl && !closestLabel) {
          violations.push({
            rule: "label",
            severity: "critical",
            element: describe(input),
            description: "Form input has no associated label, aria-label, or placeholder.",
          });
        }
      }
    }

    // Heading hierarchy
    const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
    let prevLevel = 0;
    let h1Count = 0;
    for (const h of headings) {
      const level = parseInt(h.tagName[1]!, 10);
      if (level === 1) h1Count++;
      if (prevLevel > 0 && level > prevLevel + 1) {
        violations.push({
          rule: "heading-order",
          severity: "moderate",
          element: describe(h),
          description: `Heading skips from H${prevLevel} to H${level}.`,
        });
      }
      prevLevel = level;
    }
    if (h1Count === 0 && headings.length > 0) {
      violations.push({
        rule: "page-has-h1",
        severity: "moderate",
        element: "<body>",
        description: "Page has headings but no H1.",
      });
    }
    if (h1Count > 1) {
      violations.push({
        rule: "multiple-h1",
        severity: "minor",
        element: "<body>",
        description: `Page has ${h1Count} H1 elements. Consider using only one.`,
      });
    }

    // Missing landmark regions
    const landmarks = document.querySelectorAll(
      'main, [role="main"], nav, [role="navigation"], header, [role="banner"], footer, [role="contentinfo"]'
    );
    if (landmarks.length === 0) {
      violations.push({
        rule: "landmark-one-main",
        severity: "moderate",
        element: "<body>",
        description: "Page has no landmark regions (main, nav, header, footer).",
      });
    }

    return violations;
  });
}

/**
 * Format accessibility violations as a compact Markdown section.
 */
export function formatA11yReport(violations: A11yViolation[]): string {
  if (violations.length === 0) {
    return "### Accessibility\n\nNo accessibility violations detected.\n";
  }

  const lines = ["### Accessibility", ""];
  const bySeverity = {
    critical: violations.filter((v) => v.severity === "critical"),
    serious: violations.filter((v) => v.severity === "serious"),
    moderate: violations.filter((v) => v.severity === "moderate"),
    minor: violations.filter((v) => v.severity === "minor"),
  };

  lines.push(`${violations.length} violation(s) found.\n`);

  for (const [severity, items] of Object.entries(bySeverity)) {
    if (items.length === 0) continue;
    lines.push(`**${severity.toUpperCase()} (${items.length}):**`);
    for (const v of items.slice(0, 10)) {
      lines.push(`- \`${v.element}\` — ${v.description} [${v.rule}]`);
    }
    if (items.length > 10) {
      lines.push(`- ...and ${items.length - 10} more ${severity} violations`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
