// file: scripts/csp-check.ts
// The security headers gate (C1 S3-6) on a production build, in a browser: every page the walk reaches must carry the
// headers next.config.ts sets, and Chromium must report no Content-Security-Policy violation while the shop (home → menu →
// add to cart → checkout) and the staff app (sign-in → the owner's home) render and hydrate.
//   cd apps/web && NEXT_PUBLIC_MUNIM_API=/mock NEXT_PUBLIC_MUNIM_STOREFRONT_KEY=<the mock's key> next build
//   tsx scripts/csp-check.ts [--port=4520]
// It starts `next start` on --port (MUNIM_MOCK=1), drives Chromium (playwright-core's own build) and stops it. Exit 1 on
// any failed check.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type Response } from "playwright-core";

const arg = (name: string) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
for (const a of process.argv.slice(2)) if (!/^--port=[0-9]+$/.test(a)) throw new Error(`csp-check: unknown argument ${a} (use --port=<n>)`);
const port = Number(arg("port") ?? 4520);
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

/** What every response must say (next.config.ts); a value is a substring the header must contain. */
const WANT: Record<string, string[]> = {
  "content-security-policy": ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self'"],
  "x-content-type-options": ["nosniff"],
  "x-frame-options": ["DENY"],
  "referrer-policy": ["strict-origin-when-cross-origin"],
  "permissions-policy": ["camera=()", "microphone=()", "geolocation=()"],
};

function headersOf(where: string, res: Response | null) {
  const h = res?.headers() ?? {};
  const missing = Object.entries(WANT).flatMap(([k, parts]) => parts.filter((p) => !(h[k] ?? "").includes(p)).map((p) => `${k} ⊅ ${p}`));
  check(`${where}: security headers`, res !== null && missing.length === 0, missing.join("; "));
  check(`${where}: no X-Powered-By`, res !== null && h["x-powered-by"] === undefined, h["x-powered-by"] ?? "");
}

async function until(what: string, ok: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`csp-check: timed out waiting for ${what}`);
}

/** Violations as the page reports them (securitypolicyviolation) and as Chromium logs them to the console. */
async function watch(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeFunction("__cspViolation", (v: string) => { seen.push(v); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolation(v: string): void }).__cspViolation(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) seen.push(`console: ${m.text().slice(0, 200)}`); });
  return seen;
}

async function walk(page: Page) {
  headersOf("shop home", await page.goto(`${base}/`));
  await page.getByRole("link", { name: /Hazratganj/ }).first().click();
  await page.waitForURL(/\/o\/[0-9a-f-]{36}$/);
  const menu = page.url();
  const add = page.getByRole("button", { name: "Add Cardamom Knot" });
  check("menu hydrated (add to cart works)", await add.waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await add.click();
  await page.getByRole("button", { name: /^Cart, \d/ }).click();
  await page.getByRole("link", { name: "Go to checkout" }).click();
  await page.waitForURL(/\/checkout$/);
  check("checkout rendered", await page.locator("#f-name").waitFor({ timeout: 15_000 }).then(() => true, () => false));
  headersOf("checkout (full load)", await page.reload());
  headersOf("menu (full load)", await page.goto(menu));

  headersOf("staff sign-in", await page.goto(`${base}/staff/sign-in`));
  await page.getByRole("button", { name: "Sign in as Nandini Mehrotra" }).click();
  await page.waitForURL(/\/staff\/home$/, { timeout: 20_000 });
  check("owner home rendered after sign-in", await page.locator("h1").first().waitFor({ timeout: 20_000 }).then(() => true, () => false));
  const api = await page.request.get(`${base}/mock/v1/storefront/outlets`);
  check("API path (/mock): nosniff", (api.headers()["x-content-type-options"] ?? "") === "nosniff");
}

async function main() {
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) throw new Error("csp-check: no production build here: run `next build` on the mock first");
  const next: ChildProcess = spawn(join("node_modules", ".bin", "next"), ["start", "-p", String(port)], { env: { ...process.env, MUNIM_MOCK: "1" }, stdio: "ignore" });
  try {
    await until("next start", async () => (await fetch(`${base}/`)).ok);
    const browser = await chromium.launch({ executablePath: chromium.executablePath(), args: ["--headless=new"] });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      const seen = await watch(page);
      // A page the policy broke may stop the walk; the violations are still reported.
      await walk(page).catch((e: unknown) => check("the walk", false, (e instanceof Error ? e.message : String(e)).split("\n")[0]!));
      await page.waitForTimeout(500);
      check("no Content-Security-Policy violations", seen.length === 0, seen.slice(0, 5).join(" | "));
    } finally {
      await browser.close();
    }
  } finally {
    next.kill();
  }
  console.log(failed ? `csp-check: FAIL (${failed})` : "csp-check: ok");
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
