---
name: pwa-nextjs
description: Ship an installable PWA on Next.js App Router - manifest, icons, service worker, install button, middleware traps, and a headless verification harness. Use when making a Next.js App Router app installable, or when the install button or install prompt does not appear.
when_to_use: When making a Next.js App Router app installable, or when the install button does not appear
user-invocable: false
paths: ["**/app/manifest.*", "**/public/sw.js", "**/public/manifest.json", "**/proxy.ts", "**/middleware.ts"]
effort: medium
---

# PWA on Next.js App Router

For Workbox, Vite, or framework-agnostic caching strategy, use a general PWA guide.
This one is about Next.js App Router specifics and about **why the install button does not show up**,
which is where most of the time gets burned.

---

## Read this first: two install paths, not one

This single distinction causes most wasted cycles. Chrome has two ways to install,
with different requirements:

| Path | Service worker required? |
|---|---|
| Browser menu (⋮ → Install app) | **No.** Removed in Chrome 108 mobile / 112 desktop |
| Automatic prompt (the button Chrome shows on its own) | **Yes**, must have a `fetch` handler |

From Chrome's own blog: *"we have removed the requirement to have a service worker
that implements the `fetch()` method for installation from the menu"*, then
*"For now the algorithm that displays the install prompt still requires the
presence of a `fetch()` handler."*

Consequences:

- Generic "installability criteria" pages often omit this. They describe the menu
  path and say no service worker is needed. That is true and misleading.
- Even with a `fetch` handler, Chrome's automatic prompt is stingy: it needs
  engagement, fires once, and stays quiet for months if dismissed.
- **Therefore: always ship your own install button.** Never rely on the browser
  offering. This is not optional polish; it is the difference between users
  installing and not.

---

## Deliver all seven pieces at once

A PWA is not incremental. Shipping four of these looks identical to shipping zero,
because nothing installs until the set is complete. Each partial deploy costs the
user a real device test. Build the whole list, verify locally, then ship once.

1. `app/manifest.ts`
2. Icons: 192, 512, and a separate maskable
3. `public/sw.js` with a `fetch` handler
4. A client component that registers the worker
5. Your own install button
6. Middleware or proxy exemptions
7. iOS metadata

### 1. `app/manifest.ts`

Next serves this at `/manifest.webmanifest` and injects the `<link rel="manifest">`
by itself. Do not add `manifest:` to `metadata` as well, or you get two link tags.

```ts
import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "App Name",
    short_name: "App",
    description: "...",
    start_url: "/",
    id: "/",
    scope: "/",
    display: "standalone",
    lang: "pt-BR",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Required for getInstalledRelatedApps(), see the install button section
    related_applications: [
      { platform: "webapp", url: "https://YOUR-DOMAIN/manifest.webmanifest" },
    ],
  }
}
```

Never set `prefer_related_applications: true`. It blocks installation.

### 2. Icons

Requirements: a 192 and a 512 with `purpose: "any"`, plus a separate entry with
`purpose: "maskable"`. One icon cannot serve both well: maskable gets cropped to a
circle by Android launchers, so its artwork must sit inside the middle ~80%.

Traps worth checking before generating:

- **A file named `icon.svg` may not be a vector.** Design tools export a raster PNG
  wrapped in an SVG. Upscaling it to 512 gives a blurry icon. Check the file.
- **A transparent logo needs an opaque background.** White artwork vanishes on a
  light launcher, and maskable icons require opacity anyway.
- **A logo file often includes a wordmark.** Legible at 512, mud at 192. Crop to the
  symbol. Open the file and look; do not assume from the filename.

The maskable safe zone is a circle with radius 40% of the icon (205px on 512). A
square that fits inside it is at most 289px wide; a 320px square already pokes its
corners out. Use 288 and let `-trim` handle non-square logos.

With ImageMagick 7 (`magick`; on ImageMagick 6 the command is `convert`), from a
large source:

```bash
BG='#111111'
magick logo.png -trim +repage -resize 154x154 -background "$BG" \
  -gravity center -extent 192x192 -alpha remove -alpha off public/icon-192.png
magick logo.png -trim +repage -resize 410x410 -background "$BG" \
  -gravity center -extent 512x512 -alpha remove -alpha off public/icon-512.png
# maskable: the whole artwork must fit the 205px safe circle
magick logo.png -trim +repage -resize 288x288 -background "$BG" \
  -gravity center -extent 512x512 -alpha remove -alpha off public/icon-maskable-512.png
# iOS home screen icon, see section 7
magick logo.png -trim +repage -resize 144x144 -background "$BG" \
  -gravity center -extent 180x180 -alpha remove -alpha off app/apple-icon.png
```

Verify the maskable by cropping to the safe circle yourself instead of trusting the
math. Anything cut off in `preview.png` will be cut off on some launcher:

```bash
magick public/icon-maskable-512.png \
  \( -size 512x512 xc:none -fill white -draw "circle 256,256 256,51" \) \
  -alpha off -compose CopyOpacity -composite preview.png
```

### 3. `public/sw.js`

The worker exists to satisfy the prompt criterion and to give a decent offline
screen. It does **not** need to cache much, and in an authenticated app it must not.

```js
const CACHE = "app-v1"
// Every entry must answer 200 without a session: one failure rejects addAll and
// the worker never installs. Add "/" only if it is a static shell (see below).
const PRECACHE = ["/offline.html", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"]

self.addEventListener("install", (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Pass through untouched: writes, other origins, and every API route.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) return

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () =>
        (await caches.match(request)) || caches.match("/offline.html"),
      ),
    )
    return
  }

  // Precached files: serve from cache.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
    return
  }

  // Only build output is cached at runtime. It is hashed and immutable, so
  // cache-first is safe. Everything else, images included, stays network-only:
  // a same-origin avatar or upload is user data just like an API response.
  if (!url.pathname.startsWith("/_next/static/")) return

  event.respondWith(
    caches.match(request).then((cached) =>
      cached || fetch(request).then((res) => {
        if (res.ok && res.type === "basic") {
          const clone = res.clone()
          caches.open(CACHE).then((c) => c.put(request, clone))
        }
        return res
      }),
    ),
  )
})
```

**Never cache API responses in an app behind login**, not even network-first. Generic
PWA guides recommend network-first for `/api/`, which still writes responses to the
cache. On a shared phone that serves one user's data to the next. Network-only is the
correct strategy there, and it costs nothing since those requests are dynamic anyway.

The same goes for images. Caching every `image` request cache-first looks harmless
until the app serves avatars or uploads from its own origin. Restrict runtime caching
to `/_next/static/`, which is content-hashed and never user-specific.

Precaching `/` is fine only when it is a static prerendered shell that resolves auth
client side. Confirm with the build output: `○` means static. If `/` redirects to
`/login` for anonymous users, the cache stores a redirected response, and serving it
to a navigation fails with a network error instead of showing the offline page.

### 4. Registering the worker

Neither `beforeinstallprompt` nor `getInstalledRelatedApps` is in TypeScript's DOM
lib, so declare them once, e.g. in `types/pwa.d.ts`:

```ts
declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
  }
  interface Window {
    deferredPrompt?: BeforeInstallPromptEvent | null
  }
  interface Navigator {
    getInstalledRelatedApps?: () => Promise<{ platform: string; url?: string; id?: string }[]>
  }
}
export {}
```

**Capture `beforeinstallprompt` before React exists.** On repeat visits the worker is
already active, so Chrome can fire the event while the page is still hydrating. A
listener added in `useEffect` misses it, and the event does not fire again on that
page load: the button still shows, but falls back to menu instructions instead of
the native prompt. Listen from a plain inline `<script>` in the root layout's
`<head>`, which runs during HTML parsing:

```tsx
// app/layout.tsx
const captureInstallPrompt = `
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault()
  window.deferredPrompt = e
  window.dispatchEvent(new Event("app-ready-to-install"))
})
window.addEventListener("appinstalled", function () { window.deferredPrompt = null })
`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: captureInstallPrompt }} />
      </head>
      <body>
        <PWARegistry />
        {children}
      </body>
    </html>
  )
}
```

Not `next/script` with `strategy="beforeInteractive"`: in the App Router it is
queued in `self.__next_s` and only runs when Next's runtime boots, which is the
same race. With a strict CSP, give the inline script your nonce.

The registry then only registers the worker:

```tsx
"use client"
import { useEffect } from "react"

export function PWARegistry() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    navigator.serviceWorker.register("/sw.js").catch(console.error)
  }, [])

  return null
}
```

Registration failure must not break the app.

### 5. Your own install button

**The trap:** gating render on `beforeinstallprompt` reproduces the exact problem the
button exists to solve. Chrome fires that event under the same stingy heuristics as
its own prompt, so a button that waits for it is a button that often never appears.

**The other trap:** `matchMedia("(display-mode: standalone)")` only tells you whether
*this page* is running inside the installed app. Someone who installed and then opens
the site in a normal tab still sees the button.

Getting both right needs `getInstalledRelatedApps()`, which answers "is it installed
on this device" without the event. It requires the self-referencing
`related_applications` entry in the manifest, a secure context, and a top level
browsing context. Chrome only; elsewhere it is absent and you fall back gracefully.

Two more details the button needs. `prompt()` works once per event, so drop the
stashed event after calling it. And listen for `appinstalled`, or someone who just
installed through the button keeps seeing it until they reload.

**Recommended shape for public apps: a banner that collapses into a chip.** On the
first visit, show a large banner for a few seconds, then shrink it to a small,
permanent "Get app" entry. It is visible enough to be noticed and quiet enough not to
annoy anyone who does not want it. For an internal app behind login, a plain button
on the login screen is enough.

```tsx
"use client"
import { useEffect, useState } from "react"

const SEEN_KEY = "install-banner-seen"

export function InstallButton() {
  const [installed, setInstalled] = useState(true) // assume installed until known
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches)

    navigator.getInstalledRelatedApps?.()
      .then((apps) => { if (apps.some((a) => a.platform === "webapp")) setInstalled(true) })
      .catch(() => { /* unsupported: leave the button up, the safe default */ })

    const onInstalled = () => setInstalled(true)
    window.addEventListener("appinstalled", onInstalled)
    return () => window.removeEventListener("appinstalled", onInstalled)
  }, [])

  // Big banner once per device, then the chip only. Showing it on every visit
  // turns it into noise.
  useEffect(() => {
    if (installed) return
    let seen = false
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1"
      localStorage.setItem(SEEN_KEY, "1")
    } catch { /* storage blocked: treat as seen, the chip still shows */ seen = true }
    if (seen) return
    setExpanded(true)
    const timer = setTimeout(() => setExpanded(false), 6000)
    return () => clearTimeout(timer)
  }, [installed])

  if (installed) return null

  const install = async () => {
    setExpanded(false)
    const event = window.deferredPrompt
    if (event) {
      window.deferredPrompt = null // single use
      await event.prompt()
      if ((await event.userChoice).outcome === "accepted") setInstalled(true)
      return
    }
    showInstallInstructions() // yours: iOS "Share > Add to Home Screen", else the browser menu
  }

  return (
    <div className={expanded ? "install install--banner" : "install install--chip"}>
      {/* Same accessible name in both states, so tests and screen readers find it */}
      <button type="button" aria-label="Install app" onClick={install}>
        {expanded ? "Install the app for faster access" : "Get app"}
      </button>
      {expanded && (
        <button type="button" aria-label="Dismiss" onClick={() => setExpanded(false)}>×</button>
      )}
    </div>
  )
}
```

Banner rules:

- **Overlay, never push content.** `position: fixed`. A banner that pushes the page
  down and then shrinks causes layout shift and mis-taps.
- **Dismiss collapses right away**, no waiting for the timer.
- **Respect `prefers-reduced-motion`** in the collapse transition.
- **The chip follows the same "installed" rule** as the banner: gone on
  `getInstalledRelatedApps` or `appinstalled`.

Rule of thumb: showing the button to someone who already installed is a smaller
failure than never showing it. Default to visible.

### 6. Middleware and proxy exemptions

**This silently kills PWAs and is easy to miss.** An auth middleware that redirects
unauthenticated requests will redirect `/manifest.webmanifest` and `/sw.js` too. The
browser then never validates installability, and nothing in the UI explains why.

Next 16 renamed `middleware.ts` to `proxy.ts` with a `proxy()` export. The matcher
export is still named `config`.

```ts
export const config = {
  matcher: [
    // The `$` matters: without it the exclusion matches by prefix and
    // /sw.jsx would bypass the auth check.
    "/((?!_next/static|_next/image|favicon\\.ico$|manifest\\.webmanifest$|sw\\.js$|offline\\.html$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
```

Exempt every public root file, including `offline.html`, which the worker fetches over
the network during precache. Anchor each name and confirm both directions: the file
returns 200 without a session, and protected routes still redirect.

The extension rule exempts **every** image path, not only your icons. If the app serves
user uploads from its own origin (say `/uploads/x.png`), they bypass auth too. In that
case list the public files by name instead of by extension.

The same class of bug hits `robots.txt`, `sitemap.xml` and `.well-known/*` later.

### 7. iOS metadata

iOS has no install event. These are what make it open without the address bar after
"Add to Home Screen".

```ts
export const metadata: Metadata = {
  appleWebApp: { capable: true, statusBarStyle: "default", title: "App" },
  other: {
    // Next emits `mobile-web-app-capable` from appleWebApp already; repeating it
    // there duplicates the tag. It no longer emits the apple-prefixed one.
    "apple-mobile-web-app-capable": "yes",
  },
}
```

iOS also wants its own icon. Several versions ignore the manifest icons and fall back
to a page screenshot. Put a 180×180 opaque PNG at `app/apple-icon.png` (command in
section 2) and Next emits `<link rel="apple-touch-icon">` by itself.

After building, grep the prerendered HTML for duplicate meta tags.

---

## Verify with the browser, not with opinion

Chrome will tell you exactly what it thinks. Use `Page.getInstallabilityErrors` over
CDP instead of reasoning about criteria. `verify-pwa.mjs`, shipped next to this skill,
is a ready harness: it boots the production build on a spare port, drives headless
Chromium, and asserts installability, manifest parsing, worker state, button
visibility, that the button disappears when the browser reports the app installed,
and the offline fallback.

Run it from the project root. It loads `@playwright/test` from the project, so the
project needs it installed, plus Chromium once:

```bash
pnpm add -D @playwright/test && npx playwright install chromium
pnpm build
node /path/to/skill/verify-pwa.mjs                  # exits non-zero on any failure
PROTECTED_PATH=/dashboard node /path/to/skill/verify-pwa.mjs   # also checks auth still redirects
```

The button check matches the accessible name against `BUTTON_LABEL` (default
`instal`, covering "install" and "instalar"). POSIX only.

An empty `installabilityErrors` array means the platform side is done. If the button
still does not appear at that point, the problem is your UI, not the manifest.

---

## Measurement traps that produce false conclusions

Every one of these has caused a real misdiagnosis. They are about method, not PWAs,
and they are the reason a simple task turns into hours.

- **Never poll production in a loop.** Repeated curl or headless hits trigger bot
  protection. Vercel answers `403` with `x-vercel-mitigated: challenge` and serves a
  checkpoint page. Reading that page as if it were the app leads to confident, wrong
  conclusions like "the deploy failed" or "the button is missing". Worse, the block is
  per IP, so the user's phone on the same WiFi loses access too. Verify in the local
  build instead, and ask the user to confirm deploys.
- **`spawn("pnpm", ["start"])` then `kill()` kills pnpm, not the server.** The child
  keeps listening, so an offline test never goes offline. Use `detached: true` and
  `process.kill(-pid)`, then assert the port is actually dead before drawing any
  conclusion from it.
- **Do not read `page.content()` after a navigation that may have failed.** You get
  the previous page and misread it as the new one. Capture the response object from
  `page.goto` and check its status.
- **`context.setOffline(true)` does not reliably reach the service worker.** To test
  the offline fallback for real, kill the server and navigate to a URL that was never
  requested, so neither the HTTP cache nor a route prefetch can satisfy it.
- **Headless Chromium does not fire `beforeinstallprompt`.** Absence there proves
  nothing about a real device. Do not design around that observation.

---

## Checklist

- [ ] `app/manifest.ts` with name, short_name, start_url, display, icons
- [ ] Icons 192 and 512 `any`, plus a separate `maskable`, checked by eye
- [ ] `related_applications` pointing at the manifest, `prefer_related_applications` unset
- [ ] Maskable previewed against the 205px safe circle
- [ ] `public/sw.js` with a `fetch` handler; runtime cache limited to `/_next/static/`
- [ ] Every precache entry answers 200 without a session
- [ ] `public/offline.html`
- [ ] `BeforeInstallPromptEvent` and `getInstalledRelatedApps` typed
- [ ] `beforeinstallprompt` captured by an inline `<script>` in `<head>`, not a `useEffect`
- [ ] Registry component mounted in the layout
- [ ] Install button that does not depend on `beforeinstallprompt` to render
- [ ] Button drops the prompt after use and hides on `appinstalled`
- [ ] Middleware or proxy exempts manifest, sw.js, offline.html, each anchored with `$`
- [ ] Protected routes still redirect after the matcher change
- [ ] `app/apple-icon.png`, iOS metadata present, no duplicated meta tags
- [ ] `verify-pwa.mjs` fully green against the production build
