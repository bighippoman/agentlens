# agentlens

AI-agent-native web inspector. Semantic page understanding in < 500 tokens.

## The Problem

AI agents burn 90% of their context window trying to understand a web page. A single DOM dump is 50k+ tokens. Traces, videos, and test output make it worse. By the time the agent knows what's on screen, it has no room left to think.

## What AgentLens Does

AgentLens gives AI agents a semantic understanding of web pages — not raw HTML, not flat element lists, but structured components with intent:

```
Page: My App (https://myapp.com/login)
Status: ready
Suggested: fill 2 required field(s) in "Login": Email, Password

[nav] Header: Home, About, Pricing, [Sign In]
[form] Login: 0/2 filled, 2 required empty, submit: "Sign In"
    Email *: empty
    Password *: empty
[hero] Welcome: CTA: "Get Started"
Actions: fill "Login" form | submit "Login" form | navigate to "About"
```

**~120 tokens.** Not 50,000.

## Install

```bash
npm install agentlens
```

## Quick Start

### The Agent API (recommended)

```ts
import { AgentPage } from "agentlens/agent";

const agent = new AgentPage(page);
const digest = await agent.goto("https://myapp.com");
// digest.text → compact semantic page model
// digest.suggestedAction → "fill 2 required fields in Login"
// digest.tokens → 127

await agent.do("log in with user@test.com / secret123");
// → finds login form, fills both fields, clicks submit, waits for navigation

const delta = await agent.whatChanged();
// delta.text → "Navigated → /dashboard\n+ [nav] Sidebar\n- [form] Login"
// delta.tokens → 42
```

### Intent-Based Actions

```ts
await agent.do("submit form");
await agent.do("navigate to Pricing");
await agent.do("search for typescript testing");
await agent.do("fill form with {email: user@test.com, name: John}");
await agent.do("dismiss blockers");
await agent.do("wait until ready");
await agent.do("scroll to Footer");
await agent.do("go back");
```

### Delta-Aware State

```ts
const digest = await agent.digest();     // full page model (~120 tokens)
// ... agent does things ...
const delta = await agent.whatChanged();  // only what changed (~40 tokens)
// "[no change]" if nothing happened (3 tokens)
```

### Smart Blocking Detection

```ts
const digest = await agent.digest();
// digest.status.readiness → "blocked"
// digest.suggestedAction → "dismiss cookie banner"

await agent.dismissBlockers();
```

## API Layers

### Layer 1: Agent API (`agentlens/agent`)

The semantic layer. Understands pages as components, actions as intents.

```ts
import { AgentPage } from "agentlens/agent";

const agent = new AgentPage(page);
agent.digest()           // → PageDigest (components, status, suggestions)
agent.do(intent)         // → IntentResult (success, description, delta)
agent.whatChanged()      // → PageDelta (only what changed)
agent.waitUntilReady()   // → smart wait
agent.dismissBlockers()  // → auto-close modals/banners
agent.goto(url)          // → navigate + digest
agent.screenshot(label)  // → viewport screenshot + observation log
```

### Layer 2: Inspection API (`agentlens`)

Lower-level API for detailed page inspection.

```ts
import { observe, act, getVisibleState, uxReport } from "agentlens";

await observe(page, "Homepage loaded");
await act(page, "click Sign In");
await act(page, "fill Email with test@x.com");
const state = await getVisibleState(page);
await uxReport();
```

## Test Fixture

```ts
import { test, expect } from "agentlens/fixture";

test("checkout flow", async ({ lens }) => {
  await lens.page.goto("/checkout");
  await lens.observe("Checkout page");
  await lens.act("fill Email with user@test.com");
  await lens.act("click Place Order");
  await lens.observe("Confirmation");
  await lens.uxReport();
});
```

## Test Reporter

```ts
reporter: [
  ["html"],
  ["agentlens/reporter"],
],
```

Produces `.agentlens/failures.md` — compact failure summaries. Never inlines traces, screenshots, or DOM.

## CLI

```bash
agentlens init              # scaffold config + example test
agentlens doctor --fix      # auto-patch test config
agentlens clean             # clear observation log
agentlens summarize         # regenerate report
agentlens diff a.json b.json  # compare runs
agentlens ci                # generate CI workflow
```

## Features

| Feature | What it does |
|---------|-------------|
| Semantic digest | Pages as components (forms, nav, modals), not elements |
| Intent actions | "submit form", "log in with" — not "click button" |
| Delta tracking | Only what changed since last check |
| Smart waiting | Watches spinners, network, DOM — not timers |
| Blocker detection | Auto-detects modals, cookie banners, overlays |
| Context budget | Configurable token limit with priority truncation |
| Performance metrics | LCP, CLS, TTFB on demand |
| A11y audit | Lightweight accessibility check |
| Snapshot testing | Regression test visible state |
| HTML report | Self-contained with inline screenshots |

## Agent Instructions

```
Use agentlens for web page inspection:
- import { AgentPage } from "agentlens/agent"
- agent.digest() for page understanding (< 500 tokens)
- agent.do(intent) for actions
- agent.whatChanged() for delta updates
- Never call page.content()
```

## How It Works

```
                  ┌──────────────┐     ┌──────────────────────┐
   Web Page ───► │  AgentLens    │────►│  [form] Login: 0/2   │  ~120 tokens
                  │  semantic     │     │  [nav] Home, About   │
                  │  components   │     │  Suggested: fill     │
                  └──────────────┘     └──────────────────────┘

                                  vs.  page.content() → 50,000 tokens
```

## License

MIT
