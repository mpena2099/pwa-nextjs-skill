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
 * Requires @playwright/test in the project. Run from the project root.
 *
 * Env:
 *   PORT           spare port to boot on (default 3199)
 *   START_CMD      command to serve the build (default "pnpm start")
 *   BUTTON_LABEL   accessible name of the install button, as a regex source
 *                  (default "instal", matching English and Portuguese labels)
 */

import { spawn } from "node:child_process"
import { chromium } from "@playwright/test"

const PORT = Number(process.env.PORT ?? 3199)
const BASE = `http://127.0.0.1:${PORT}`
const START = (process.env.START_CMD ?? "pnpm start").split(" ")
// "instal" is the common prefix of "install" and the Portuguese "instalar",
// which has a single l. Override BUTTON_LABEL for any other wording.
const BUTTON = new RegExp(process.env.BUTTON_LABEL ?? "instal", "i")

// detached so the whole process group dies. Killing the package manager alone
// leaves the server listening, which silently invalidates any offline test.
const server = spawn(START[0], [...START.slice(1), "-p", String(PORT)], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})
const stopServer = () => {
  try { process.kill(-server.pid, "SIGKILL") } catch {}
}

const results = []
const check = (name, passed, detail = "") => results.push({ name, passed, detail })

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/manifest.webmanifest`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`server did not come up on ${BASE}`)
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch()
  const ctx = await browser.newContext({ serviceWorkers: "allow" })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send("Page.enable")

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  await page.waitForTimeout(6000)

  // The verdict that matters: Chrome's own opinion.
  const { installabilityErrors = [] } = await cdp.send("Page.getInstallabilityErrors")
  check("chrome reports no installability errors",
        installabilityErrors.length === 0, JSON.stringify(installabilityErrors))

  const appManifest = await cdp.send("Page.getAppManifest")
  check("manifest parses without errors",
        (appManifest.errors ?? []).length === 0, JSON.stringify(appManifest.errors))

  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json()

  const sizes = (manifest.icons ?? []).map((i) => i.sizes)
  check("icons include 192 and 512",
        sizes.includes("192x192") && sizes.includes("512x512"), JSON.stringify(sizes))
  check("a maskable icon exists",
        (manifest.icons ?? []).some((i) => i.purpose?.includes("maskable")))
  check("prefer_related_applications is not true",
        !manifest.prefer_related_applications)
  check("related_applications self-reference present",
        manifest.related_applications?.[0]?.platform === "webapp",
        JSON.stringify(manifest.related_applications))

  // Public files must be reachable without a session, or the auth middleware
  // is redirecting them and the browser never validates anything.
  for (const path of ["/manifest.webmanifest", "/sw.js", "/offline.html"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" })
    check(`${path} is served anonymously`, res.status === 200, `status ${res.status}`)
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

  const swSource = await (await fetch(`${BASE}/sw.js`)).text()
  check("service worker has a fetch handler (required for the auto prompt)",
        /addEventListener\(\s*["']fetch["']/.test(swSource))
  check("service worker excludes API routes from cache",
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
  const visible = await button.isVisible().catch(() => false)
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
    const gone = !(await page.getByRole("button", { name: BUTTON }).isVisible().catch(() => false))
    check("install button hides when already installed", gone)
  }
} catch (err) {
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
console.log(failed === 0 ? "\nall green" : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
