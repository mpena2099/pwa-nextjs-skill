#!/usr/bin/env node
/**
 * PWA verification harness for Next.js App Router.
 *
 * Boots the production build on a spare port, drives headless Chromium, and asks
 * Chrome itself whether the app is installable instead of reasoning about criteria.
 *
 *   pnpm build && node verify-pwa.mjs
 *
 * Exits non-zero on any failure, so it drops into CI as is.
 *
 * Run it from the project root (the script itself can live anywhere). Requires
 * @playwright/test in the project and `npx playwright install chromium` once.
 * POSIX only: the server is stopped by killing its process group.
 *
 * Env:
 *   PORT            spare port to boot on (default 3199), must be free
 *   START_CMD       command to serve the build (default "pnpm start"); gets PORT
 *                   through the environment, not a flag
 *   BUTTON_LABEL    accessible name of the install button, as a regex source
 *                   (default "instal", matching English and Portuguese labels)
 *   PROTECTED_PATH  optional route that must still require auth, e.g. "/dashboard"
 */

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const PORT = Number(process.env.PORT ?? 3199)
const BASE = `http://127.0.0.1:${PORT}`
const START = (process.env.START_CMD ?? "pnpm start").trim().split(/\s+/)
// "instal" is the common prefix of "install" and the Portuguese "instalar",
// which has a single l. Override BUTTON_LABEL for any other wording.
const BUTTON = new RegExp(process.env.BUTTON_LABEL ?? "instal", "i")
const PROTECTED_PATH = process.env.PROTECTED_PATH

// Bare ESM imports resolve from this file's directory, so a copy installed with
// the skill would never find the project's Playwright. Resolve from the cwd.
let chromium
try {
  const requireFromProject = createRequire(path.join(process.cwd(), "package.json"))
  const mod = await import(pathToFileURL(requireFromProject.resolve("@playwright/test")).href)
  // CJS module: named exports are not always detected, default always is.
  chromium = mod.chromium ?? mod.default?.chromium
  if (!chromium) throw new Error("no chromium export")
} catch {
  console.error(`@playwright/test not found in ${process.cwd()}. Install it in the project ` +
    "(pnpm add -D @playwright/test && npx playwright install chromium) and run this from the project root.")
  process.exit(1)
}

// Otherwise next start dies with EADDRINUSE and the harness silently tests
// whatever was already listening, often a stale server from a previous run.
try {
  await fetch(BASE, { redirect: "manual", signal: AbortSignal.timeout(1000) })
  console.error(`port ${PORT} is already in use; a stale server would be tested instead of this build. Free it or set PORT.`)
  process.exit(1)
} catch { /* nothing listening: good */ }

// Keep the tail of the server output, and keep reading so the pipe never fills
// and blocks the server.
const output = []
const keep = (chunk) => {
  output.push(...chunk.toString().split("\n").filter(Boolean))
  output.splice(0, Math.max(0, output.length - 40))
}
const outputTail = () => output.length ? `\n--- server output ---\n${output.join("\n")}` : ""

// PORT through the environment: `npm start -p` swallows the flag, and next start
// reads PORT on its own.
// detached so the whole process group dies. Killing the package manager alone
// leaves the server listening, which silently invalidates any offline test.
const server = spawn(START[0], START.slice(1), {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})
let serverGone = null
server.stdout.on("data", keep)
server.stderr.on("data", keep)
server.on("error", (err) => { serverGone = `failed to start: ${err.message}` })
server.on("exit", (code, signal) => { serverGone ??= `exited with ${signal ?? `code ${code}`}` })
const stopServer = () => {
  try { process.kill(-server.pid, "SIGKILL") } catch {}
}

const results = []
const check = (name, passed, detail = "") => results.push({ name, passed, detail })

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    if (serverGone) throw new Error(`server ${serverGone}`)
    try {
      if ((await fetch(`${BASE}/`, { redirect: "manual" })).status < 500) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`server did not come up on ${BASE}`)
}

let browser
let harnessFailed = false
try {
  await waitForServer()
  browser = await chromium.launch()
  const ctx = await browser.newContext({ serviceWorkers: "allow" })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send("Page.enable")

  // Never read a page whose navigation failed: you get the previous one.
  const home = await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  check("home page loads", !!home && home.status() < 400, `status ${home?.status()}`)

  // Wait for the worker instead of guessing a delay. The first load is not
  // controlled until clients.claim lands, so reload once if needed.
  await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready,
    new Promise((r) => setTimeout(r, 15000)),
  ]))
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: "networkidle" })
  }
  // Let Chrome's installability check settle.
  await page.waitForTimeout(1500)

  // The verdict that matters: Chrome's own opinion.
  const { installabilityErrors = [] } = await cdp.send("Page.getInstallabilityErrors")
  check("chrome reports no installability errors",
        installabilityErrors.length === 0, JSON.stringify(installabilityErrors))

  const appManifest = await cdp.send("Page.getAppManifest")
  check("manifest parses without errors",
        (appManifest.errors ?? []).length === 0, JSON.stringify(appManifest.errors))

  const manifestUrl = await page.evaluate(() => document.querySelector("link[rel=manifest]")?.href ?? null)
    ?? `${BASE}/manifest.webmanifest`
  const manifestPath = new URL(manifestUrl).pathname

  // Public files must be reachable without a session, or the auth middleware
  // is redirecting them and the browser never validates anything.
  for (const p of [manifestPath, "/sw.js", "/offline.html"]) {
    const res = await fetch(`${BASE}${p}`, { redirect: "manual" })
    check(`${p} is served anonymously`, res.status === 200, `status ${res.status}`)
  }

  // A redirected manifest comes back as the login page's HTML. Parse leniently
  // so the anonymous-access failure above stays the reported cause.
  let manifest = {}
  try { manifest = await (await fetch(`${BASE}${manifestPath}`, { redirect: "manual" })).json() } catch {}

  const sizes = (manifest.icons ?? []).map((i) => i.sizes)
  check("icons include 192 and 512",
        sizes.includes("192x192") && sizes.includes("512x512"), JSON.stringify(sizes))
  check("a maskable icon exists",
        (manifest.icons ?? []).some((i) => i.purpose?.includes("maskable")))
  check("prefer_related_applications is not true",
        !manifest.prefer_related_applications)
  // getInstalledRelatedApps only matches an entry whose url is this manifest.
  const related = manifest.related_applications ?? []
  check("related_applications self-reference present",
        related.some((r) => {
          try { return r.platform === "webapp" && new URL(r.url, manifestUrl).pathname === manifestPath }
          catch { return false }
        }),
        JSON.stringify(related))

  // And the exemptions must not have opened everything else.
  if (PROTECTED_PATH) {
    const res = await fetch(`${BASE}${PROTECTED_PATH}`, { redirect: "manual" })
    check(`${PROTECTED_PATH} still requires auth`,
          (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403,
          `status ${res.status}`)
  }

  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    return {
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      state: reg?.active?.state ?? null,
    }
  })
  check("service worker active and controlling",
        sw.state === "activated" && !!sw.controller, JSON.stringify(sw))

  // Comments stripped so a commented-out handler does not count. The guard on
  // `:` keeps URLs like https://... intact.
  const swSource = (await (await fetch(`${BASE}/sw.js`)).text())
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
  check("service worker has a fetch handler (required for the auto prompt)",
        /addEventListener\(\s*["']fetch["']|\bonfetch\s*=/.test(swSource))
  check("service worker mentions an /api/ guard (heuristic)",
        /\/api\//.test(swSource), "no /api/ guard found in sw.js")

  const head = await page.evaluate(() => ({
    manifestLinks: document.querySelectorAll("link[rel=manifest]").length,
    mobileCapable: document.querySelectorAll('meta[name="mobile-web-app-capable"]').length,
    appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content ?? null,
  }))
  check("exactly one manifest link and no duplicated capability meta",
        head.manifestLinks === 1 && head.mobileCapable <= 1, JSON.stringify(head))
  check("apple-mobile-web-app-capable present for iOS",
        head.appleCapable === "yes", JSON.stringify(head))

  // The install button must not depend on beforeinstallprompt to render.
  // Headless Chromium never fires that event, so if the button shows here it
  // is genuinely independent of it.
  const button = page.getByRole("button", { name: BUTTON })
  const visible = await button.first().isVisible().catch(() => false)
  check("install button renders without beforeinstallprompt", visible)

  // And it must disappear once the browser reports the app installed.
  // Only meaningful if it rendered in the first place: asserting the absence of
  // a button that never existed is a vacuous pass, and vacuous passes are how a
  // harness turns into a rubber stamp.
  if (!visible) {
    check("install button hides when already installed", false,
          "cannot prove it: the button never rendered, so absence means nothing")
  } else {
    await page.addInitScript(() => {
      navigator.getInstalledRelatedApps = async () => [{ platform: "webapp" }]
    })
    await page.reload({ waitUntil: "networkidle" })
    await page.waitForTimeout(4000)
    const gone = !(await page.getByRole("button", { name: BUTTON }).first().isVisible().catch(() => false))
    check("install button hides when already installed", gone)
  }

  // Offline fallback last, because it kills the server. setOffline does not
  // reliably reach the worker, so take the server down for real and prove it.
  stopServer()
  let down = false
  for (let i = 0; i < 20 && !down; i++) {
    try { await fetch(BASE, { redirect: "manual", signal: AbortSignal.timeout(500) }) }
    catch { down = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  check("server is really down before offline test", down)
  if (down) {
    // A URL never requested before, so neither the HTTP cache nor a prefetch
    // can answer it. Only the worker can.
    const probe = `${BASE}/__offline-probe-${Date.now()}`
    let offline = null
    try { offline = await page.goto(probe, { waitUntil: "load" }) } catch {}
    check("offline navigation falls back to offline.html",
          !!offline && offline.status() === 200 && page.url() === probe,
          offline ? `status ${offline.status()} at ${page.url()}` : "navigation failed")
  }
} catch (err) {
  harnessFailed = true
  check("harness run", false, err.message.split("\n")[0])
} finally {
  try { await browser?.close() } catch {}
  stopServer()
}

let failed = 0
for (const r of results) {
  if (!r.passed) failed++
  const detail = !r.passed && r.detail ? `  -> ${r.detail}` : ""
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.name}${detail}`)
}
if (harnessFailed) console.log(outputTail())
console.log(failed === 0 ? "\nall green" : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
