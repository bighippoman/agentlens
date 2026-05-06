import type { Page } from "@playwright/test";
import type { PageComponent } from "./types.js";

/**
 * Detect semantic components on the page via a single page.evaluate().
 *
 * Groups raw DOM elements into meaningful components:
 * nav, form, modal, toast, hero, card-list, table, footer, sidebar.
 */
export async function detectComponents(page: Page): Promise<PageComponent[]> {
  return page.evaluate(() => {
    type CType = "nav" | "form" | "modal" | "toast" | "hero" | "card" | "card-list" | "table" | "media" | "footer" | "sidebar" | "content" | "unknown";

    interface Component {
      type: CType;
      name: string;
      summary: string;
      fields?: { name: string; type: string; label: string; value: string; required: boolean; empty: boolean; invalid: boolean }[];
      items?: { text: string; href: string; active: boolean }[];
      table?: { columns: string[]; rowCount: number; sampleRow: string[] | null };
      blocking?: boolean;
      actions: string[];
      selector: string;
    }

    const components: Component[] = [];
    const seen = new Set<Element>();

    function textOf(el: Element): string {
      return ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 100);
    }

    function selectorOf(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === "string"
        ? `.${el.className.trim().split(/\\s+/).slice(0, 2).map(c => CSS.escape(c)).join(".")}`
        : "";
      return `${tag}${cls}`.slice(0, 60);
    }

    function isVisible(el: Element): boolean {
      const htmlEl = el as HTMLElement;
      if (htmlEl.offsetParent === null) {
        const pos = getComputedStyle(htmlEl).position;
        if (pos !== "fixed" && pos !== "sticky") return false;
      }
      if (getComputedStyle(htmlEl).display === "none") return false;
      if (getComputedStyle(htmlEl).visibility === "hidden") return false;
      const rect = htmlEl.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function collectActions(el: Element): string[] {
      const actions: string[] = [];
      const btns = el.querySelectorAll('button, [role="button"], a[href], input[type="submit"]');
      for (const btn of btns) {
        if (!isVisible(btn)) continue;
        const text = textOf(btn) || (btn as HTMLElement).getAttribute("aria-label") || "";
        if (text && actions.length < 5) actions.push(text.slice(0, 50));
      }
      return actions;
    }

    // ── Modals / Dialogs ──
    const modals = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    for (const modal of modals) {
      if (seen.has(modal) || !isVisible(modal)) continue;
      seen.add(modal);
      const heading = modal.querySelector("h1, h2, h3, h4, [role='heading']");
      const name = heading ? textOf(heading) : "Dialog";
      components.push({
        type: "modal",
        name,
        summary: `Modal dialog: "${name}"`,
        blocking: true,
        actions: collectActions(modal),
        selector: selectorOf(modal),
      });
    }

    // Detect fixed overlays (common cookie banners, modals without role)
    const allFixed = document.querySelectorAll("*");
    for (const el of allFixed) {
      if (seen.has(el)) continue;
      const style = getComputedStyle(el as HTMLElement);
      if ((style.position === "fixed" || style.position === "sticky") && style.zIndex !== "auto") {
        const z = parseInt(style.zIndex, 10);
        if (z >= 100 && isVisible(el)) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          // Only if it's a significant overlay (not just a fixed header)
          if (rect.width > window.innerWidth * 0.3 && rect.height > 60) {
            const text = textOf(el).slice(0, 60);
            const isCookie = /cookie|consent|privacy|gdpr/i.test(text + el.className);
            if (isCookie || rect.height > window.innerHeight * 0.3) {
              seen.add(el);
              components.push({
                type: isCookie ? "toast" : "modal",
                name: isCookie ? "Cookie Banner" : "Overlay",
                summary: isCookie ? "Cookie consent banner" : `Fixed overlay: "${text}"`,
                blocking: rect.height > window.innerHeight * 0.5,
                actions: collectActions(el),
                selector: selectorOf(el),
              });
            }
          }
        }
      }
    }

    // ── Toasts / Alerts ──
    const alerts = document.querySelectorAll('[role="alert"], [role="status"]');
    for (const alert of alerts) {
      if (seen.has(alert) || !isVisible(alert)) continue;
      seen.add(alert);
      components.push({
        type: "toast",
        name: "Notification",
        summary: textOf(alert).slice(0, 80),
        blocking: false,
        actions: collectActions(alert),
        selector: selectorOf(alert),
      });
    }

    // ── Navigation ──
    const navs = document.querySelectorAll('nav, [role="navigation"], header');
    for (const nav of navs) {
      if (seen.has(nav) || !isVisible(nav)) continue;
      seen.add(nav);
      const links = nav.querySelectorAll("a[href]");
      const items: { text: string; href: string; active: boolean }[] = [];
      for (const link of links) {
        if (!isVisible(link)) continue;
        const text = textOf(link).slice(0, 40);
        if (!text) continue;
        const href = (link as HTMLAnchorElement).href || "";
        const active = link.classList.contains("active") ||
          link.getAttribute("aria-current") === "page" ||
          (link as HTMLAnchorElement).href === window.location.href;
        items.push({ text, href, active });
        if (items.length >= 10) break;
      }
      if (items.length === 0) continue;
      const tag = nav.tagName.toLowerCase();
      components.push({
        type: "nav",
        name: tag === "header" ? "Header" : "Navigation",
        summary: `${items.length} links: ${items.map(i => i.text).join(", ")}`,
        items,
        actions: [],
        selector: selectorOf(nav),
      });
    }

    // ── Forms ──
    const forms = document.querySelectorAll("form");
    for (const form of forms) {
      if (seen.has(form) || !isVisible(form)) continue;
      seen.add(form);
      const inputs = form.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select");
      const fields: Component["fields"] = [];
      let filledCount = 0;
      let emptyRequired = 0;

      for (const input of inputs) {
        if (!isVisible(input)) continue;
        const htmlInput = input as HTMLInputElement;
        let label = "";
        if (htmlInput.id) {
          const labelEl = document.querySelector(`label[for="${htmlInput.id}"]`);
          if (labelEl) label = textOf(labelEl).slice(0, 40);
        }
        if (!label) {
          const closest = htmlInput.closest("label");
          if (closest) label = textOf(closest).slice(0, 40);
        }
        if (!label) label = htmlInput.placeholder || htmlInput.name || htmlInput.type || "unknown";

        const isEmpty = !htmlInput.value;
        const isRequired = htmlInput.required || htmlInput.getAttribute("aria-required") === "true";
        if (!isEmpty) filledCount++;
        if (isEmpty && isRequired) emptyRequired++;

        fields.push({
          name: htmlInput.name || htmlInput.id || label,
          type: htmlInput.type || htmlInput.tagName.toLowerCase(),
          label,
          value: htmlInput.type === "password" ? (htmlInput.value ? "***" : "") : (htmlInput.value || "").slice(0, 30),
          required: isRequired,
          empty: isEmpty,
          invalid: !htmlInput.checkValidity(),
        });
      }

      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      const submitText = submitBtn ? (textOf(submitBtn) || "Submit") : null;
      const heading = form.querySelector("h1, h2, h3, h4, legend");
      const formName = heading ? textOf(heading) :
        form.id ? form.id.replace(/[-_]/g, " ") :
        form.getAttribute("aria-label") || "Form";

      const total = fields.length;
      const statusParts: string[] = [];
      if (total > 0) statusParts.push(`${filledCount}/${total} filled`);
      if (emptyRequired > 0) statusParts.push(`${emptyRequired} required empty`);
      if (submitText) statusParts.push(`submit: "${submitText}"`);

      components.push({
        type: "form",
        name: formName,
        summary: statusParts.join(", "),
        fields,
        actions: submitText ? [submitText] : [],
        selector: selectorOf(form),
      });
    }

    // ── Tables ──
    const tables = document.querySelectorAll('table, [role="grid"]');
    for (const table of tables) {
      if (seen.has(table) || !isVisible(table)) continue;
      seen.add(table);
      const headers = table.querySelectorAll("th, [role='columnheader']");
      const columns = Array.from(headers).map(h => textOf(h).slice(0, 30)).filter(Boolean);
      const rows = table.querySelectorAll("tbody tr, [role='row']");
      let sampleRow: string[] | null = null;
      if (rows.length > 0) {
        const cells = rows[0]!.querySelectorAll("td, [role='cell']");
        sampleRow = Array.from(cells).map(c => textOf(c).slice(0, 30)).slice(0, 6);
      }

      const caption = table.querySelector("caption");
      const name = caption ? textOf(caption) : "Table";

      components.push({
        type: "table",
        name,
        summary: `${columns.length} columns, ${rows.length} rows`,
        table: { columns: columns.slice(0, 8), rowCount: rows.length, sampleRow },
        actions: [],
        selector: selectorOf(table),
      });
    }

    // ── Hero section (first large heading + CTA above the fold) ──
    const h1 = document.querySelector("h1");
    if (h1 && isVisible(h1) && !seen.has(h1)) {
      const rect = h1.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.5) {
        const parent = h1.closest("section, div, main") || h1.parentElement;
        if (parent && !seen.has(parent)) {
          seen.add(parent);
          const ctaBtn = parent.querySelector('button, a.cta, a[href], [role="button"]');
          const ctaText = ctaBtn && isVisible(ctaBtn) ? textOf(ctaBtn).slice(0, 40) : null;
          components.push({
            type: "hero",
            name: textOf(h1).slice(0, 60),
            summary: ctaText ? `CTA: "${ctaText}"` : "No primary CTA found",
            actions: ctaText ? [ctaText] : [],
            selector: selectorOf(parent),
          });
        }
      }
    }

    // ── Footer ──
    const footer = document.querySelector('footer, [role="contentinfo"]');
    if (footer && isVisible(footer) && !seen.has(footer)) {
      seen.add(footer);
      const links = footer.querySelectorAll("a[href]");
      const linkTexts = Array.from(links).filter(l => isVisible(l)).map(l => textOf(l).slice(0, 30)).filter(Boolean).slice(0, 6);
      components.push({
        type: "footer",
        name: "Footer",
        summary: linkTexts.length > 0 ? `Links: ${linkTexts.join(", ")}` : "Footer section",
        actions: [],
        selector: selectorOf(footer),
      });
    }

    return components;
  });
}
