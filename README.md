# agentlens

Zero-dependency, AI-agent-native web inspector. Semantic page understanding in < 500 tokens.

Built from scratch on Chrome DevTools Protocol. No Playwright. No Puppeteer. No runtime dependencies. Just Node.js builtins + Chrome.

## Install

```bash
npm install @jnordq/agentlens
```

That's it. No browser download step. Uses the Chrome already on your machine.

## Quick Start

```ts
import { Browser } from "@jnordq/agentlens/browser";
import { AgentPage } from "@jnordq/agentlens/agent";

const browser = await Browser.launch();
const page = await browser.newPage();
const agent = new AgentPage(page);

// Understand the page in ~120 tokens
const digest = await agent.goto("https://myapp.com");
console.log(digest.text);
// Page: My App (myapp.com/login)
// Status: ready
// Suggested: fill 2 required fields
//
// [nav] Header: Home, About, Pricing
// [form] Login: 0/2 filled
//     Email *: empty
//     Password *: empty
// [hero] Welcome: CTA "Get Started"
//
// Actions: fill form | submit | navigate

// Act with intent — not element-level clicks
await agent.do("log in with user@test.com / secret123");

// Only what changed — not the whole page again
const delta = await agent.whatChanged();
console.log(delta.text);
// Navigated → /dashboard
// + [nav] Sidebar: Dashboard, Settings
// - [form] Login
// Suggested: click "View Tasks"

await browser.close();
```

## Why

AI agents burn 90% of their context window trying to understand web pages. `page.content()` dumps 50,000 tokens of raw HTML. AgentLens returns ~120 tokens of structured signal.

| | Tokens | What you get |
|---|--------|-------------|
| `page.content()` | ~50,000 | Raw HTML noise |
| `agent.digest()` | ~120 | Semantic components + suggested actions |
| `agent.whatChanged()` | ~40 | Only the delta |
| No change | 3 | `"[no change]"` |

## Architecture

```
agentlens (zero npm dependencies)
├── browser/     WebSocket client, CDP client, Chrome launcher, BrowserPage
│                Built on: net, tls, crypto, http, child_process
├── agent/       Semantic digest, intent actions, delta tracking, blocker detection
│                Built on: browser/ + page.evaluate()
└── cli          Config scaffolding, doctor, session management
```

The only external requirement is Chrome/Chromium installed on the machine.

## Agent API

```ts
import { AgentPage } from "@jnordq/agentlens/agent";

agent.digest()           // Semantic page model — components, status, suggestions
agent.do(intent)         // High-level action — returns result + delta
agent.whatChanged()      // Only what changed since last check
agent.waitUntilReady()   // Smart wait — spinners, network, DOM stability
agent.dismissBlockers()  // Auto-close modals, cookie banners, overlays
agent.goto(url)          // Navigate + wait + digest
agent.screenshot(path)   // Viewport screenshot
```

### Supported Intents

```ts
await agent.do("submit form");
await agent.do("navigate to Pricing");
await agent.do("log in with user@test.com / password");
await agent.do("search for enterprise plan");
await agent.do("fill form with {email: a@b.com, name: John}");
await agent.do("dismiss blockers");
await agent.do("wait until ready");
await agent.do("scroll to Footer");
await agent.do("go back");
```

## Browser API

Direct access to our CDP-based browser when you need lower-level control:

```ts
import { Browser } from "@jnordq/agentlens/browser";

const browser = await Browser.launch({ headless: true });
const page = await browser.newPage();

await page.goto("https://example.com");
const title = await page.title();
await page.fill("#email", "test@example.com");
await page.click("button[type=submit]");
const value = await page.evaluate("document.title");
const screenshot = await page.screenshot({ path: "shot.png" });

await browser.close();
```

## CLI

```bash
agentlens init              # scaffold config + example
agentlens doctor --fix      # auto-patch test config
agentlens clean             # clear observation log
agentlens summarize         # regenerate report
agentlens diff a.json b.json  # compare runs
agentlens ci                # generate CI workflow
```

## Exports

| Import | What you get |
|--------|-------------|
| `agentlens` | Everything — AgentPage, Browser, BrowserPage, utilities |
| `agentlens/agent` | AgentPage, digest, intents, deltas, blockers |
| `agentlens/browser` | Browser, BrowserPage, CDP client, WebSocket client |

## Agent Instructions

Add to your AI agent's system prompt:

```
Use agentlens for web inspection:
- import { Browser } from "@jnordq/agentlens/browser"
- import { AgentPage } from "@jnordq/agentlens/agent"
- agent.digest() for compact page understanding (< 500 tokens)
- agent.do(intent) for high-level actions
- agent.whatChanged() for delta-only updates
- Never call page.content() or innerHTML
```

## Dependencies

```
runtime:  0
peer:     0
built on: node:net, node:tls, node:crypto, node:http,
          node:child_process, node:fs, node:os, node:path,
          node:events, node:url
requires: Chrome or Chromium installed on the machine
```

## License

MIT
