# pwa-nextjs

An agent skill for shipping an **installable PWA on Next.js App Router**, and for
answering the question that usually costs the most time: *why isn't the install
button showing up?*

```bash
npx skills add mpena2099/pwa-nextjs-skill
```

## Why this exists

Generic PWA guides cover service workers and caching strategies. Those are rarely
what goes wrong. What goes wrong is:

- Chrome has **two** install paths with different requirements. The browser menu
  needs no service worker; the automatic prompt still needs a `fetch` handler.
  Most "installability criteria" pages describe only the first and imply the second.
- Auth middleware silently redirects `/manifest.webmanifest` and `/sw.js`, so the
  browser never validates installability and nothing explains why.
- An install button gated on `beforeinstallprompt` reproduces the exact problem it
  was added to solve, because Chrome fires that event just as sparingly as it shows
  its own prompt.
- `display-mode: standalone` tells you whether *this page* runs inside the app, not
  whether the app is installed, so the button lingers for people who already have it.
- Half the debugging time goes to measurements that were broken: reading a page after
  a failed navigation, killing the package manager instead of the server, or parsing
  a bot-protection challenge page as if it were the app.

The skill encodes all of it, plus the shape of a complete implementation so it ships
in one pass instead of five.

## What's in here

| File | |
|---|---|
| `SKILL.md` | The skill: the seven pieces, the traps, the measurement rules |
| `verify-pwa.mjs` | A verification harness that asks Chrome directly |

## The harness

Reasoning about installability criteria is how you get it wrong. Chrome will just
tell you, over CDP. The harness boots your production build on a spare port, drives
headless Chromium, and asserts sixteen things including `Page.getInstallabilityErrors`,
worker state, middleware exemptions, duplicate meta tags, and both directions of the
install button.

```bash
pnpm build
node verify-pwa.mjs
```

Exits non-zero on failure, so it drops into CI as is.

```
PASS  chrome reports no installability errors
PASS  manifest parses without errors
PASS  icons include 192 and 512
PASS  a maskable icon exists
PASS  /sw.js is served anonymously
PASS  service worker has a fetch handler (required for the auto prompt)
PASS  service worker excludes API routes from cache
PASS  install button renders without beforeinstallprompt
PASS  install button hides when already installed
...
all green
```

Configurable through the environment:

| Variable | Default |
|---|---|
| `PORT` | `3199` |
| `START_CMD` | `pnpm start` |
| `BUTTON_LABEL` | `instal`, the common prefix of "install" and "instalar" |

Requires `@playwright/test` in the project being tested.

## Scope

Written for **Next.js App Router** (`app/manifest.ts`, `proxy.ts` / `middleware.ts`,
Next 15 and 16). For Workbox, Vite, or framework-agnostic caching strategy advice,
use a general PWA skill instead.

## License

MIT
