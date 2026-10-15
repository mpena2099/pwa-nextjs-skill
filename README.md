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
- A `beforeinstallprompt` listener added in `useEffect` misses the event when Chrome
  fires it during hydration, and so does `next/script` with `beforeInteractive`, which
  the App Router runs late. Only an inline `<script>` in `<head>` catches it reliably.
- `display-mode: standalone` tells you whether *this page* runs inside the app, not
  whether the app is installed, so the button lingers for people who already have it.
- Half the debugging time goes to measurements that were broken: reading a page after
  a failed navigation, killing the package manager instead of the server, or parsing
  a bot-protection challenge page as if it were the app.

The skill encodes all of it, plus the shape of a complete implementation so it ships
in one pass instead of five. That includes a ready install entry for public apps: a
large banner on the first visit that collapses into a small, permanent "Get app" chip,
and a service worker that caches only `/_next/static/` at runtime, so no API response,
avatar or upload from a logged-in user is ever stored.

## What's in here

| File | |
|---|---|
| `SKILL.md` | The skill: the seven pieces, the traps, the measurement rules |
| `verify-pwa.mjs` | A verification harness that asks Chrome directly |

## The harness

Reasoning about installability criteria is how you get it wrong. Chrome will just
tell you, over CDP. The harness boots your production build on a spare port, drives
headless Chromium, and asserts up to twenty things including `Page.getInstallabilityErrors`,
worker state, middleware exemptions, duplicate meta tags, both directions of the
install button, and the offline fallback with the server actually down.

Run it from the root of the project being tested. It loads Playwright from that
project, so the script itself can stay wherever the skill was installed:

```bash
pnpm add -D @playwright/test && npx playwright install chromium   # once
pnpm build
node path/to/verify-pwa.mjs
```

Exits non-zero on failure, so it drops into CI as is.

```
PASS  home page loads
PASS  chrome reports no installability errors
PASS  manifest parses without errors
PASS  /manifest.webmanifest is served anonymously
PASS  /sw.js is served anonymously
PASS  /dashboard still requires auth
PASS  service worker active and controlling
PASS  service worker has a fetch handler (required for the auto prompt)
PASS  install button renders without beforeinstallprompt
PASS  install button hides when already installed
PASS  offline navigation falls back to offline.html
...
all green
```

It refuses to run on a busy port, so it never tests a stale server by mistake, and
prints the server's output when boot fails.

Configurable through the environment:

| Variable | Default |
|---|---|
| `PORT` | `3199`, must be free |
| `START_CMD` | `pnpm start`; the port goes in through `PORT`, so `npm start` works too |
| `BUTTON_LABEL` | `instal`, the common prefix of "install" and "instalar" |
| `PROTECTED_PATH` | unset; when set, e.g. `/dashboard`, also asserts it still requires auth |

POSIX only (Linux, macOS).

## Scope and limits

Written for the **Next.js App Router** (`app/manifest.ts`, `proxy.ts` / `middleware.ts`,
Next 15 and 16), verified on Next.js 16.4.0. For the Pages Router, Workbox, Vite, or
framework-agnostic caching strategy advice, use a general PWA skill instead.

- ImageMagick is needed only to generate icons. The commands use `magick` (v7); on v6,
  replace it with `convert`.
- `getInstalledRelatedApps()` works in Chrome only. Elsewhere the install button stays
  visible, by design.
- Headless Chromium never fires `beforeinstallprompt`, so the harness proves the button
  renders without it, not the native prompt itself.

## License

MIT
