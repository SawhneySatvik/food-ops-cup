// file: scripts/nav-smoke.ts
// The real clicks on a production build, in a browser: home → menu → checkout → place → tracker (router.replace), and as
// the owner: Low stock → Request quotes for both outlets → the purchase-order draft, Suppliers → a purchase order → a
// supplier, then (T-128) Investigations → an investigation and The office → the Customers desk. Every hop into a route with
// an id in its path is a client navigation, as people make them.
//   cd apps/web && NEXT_PUBLIC_MUNIM_API=/mock NEXT_PUBLIC_MUNIM_STOREFRONT_KEY=<the mock's key> NEXT_PUBLIC_MUNIM_MOCK_CONTROLS=1 next build
//   tsx scripts/nav-smoke.ts [--port=4510] [--shots=<dir>]
// It starts `next start` on --port (MUNIM_MOCK=1) and a stand-in for the deploy platform's CDN routing on --port + 1, drives Chromium
// (playwright-core's own build) through the stand-in, and stops both. --shots also saves every Request-quotes outcome at
// 390 and 1280 px wide. Exit 1 on any failed check.
//
// Why the stand-in (go-live A, measured on munim-cobnut, 16 Oct): with Next's cacheComponents every route with an id in
// its path was prerendered as one shell with placeholder params, and the deploy platform's CDN answered each client navigation's RSC
// request from that cached shell (`x-matched-path: /o/[outletId].rsc`, HIT, segment keys `%%drp:…%%`), so useParams()
// read no real id and the page said "This link isn't valid." until a reload. `next start` renders the real params and
// cannot show that, so the stand-in answers RSC requests for such routes as the CDN did — from this build's own
// prerender-manifest and segment files — and passes everything else to `next start`.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const arg = (name: string) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
for (const a of process.argv.slice(2)) if (!/^--(port|shots)=.+$/.test(a)) throw new Error(`nav-smoke: unknown argument ${a} (use --port=<n> --shots=<dir>)`);
const port = Number(arg("port") ?? 4510);
const shots = arg("shots");
const NEXT_DIR = join(process.cwd(), ".next");
const base = `http://127.0.0.1:${port + 1}`;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

/** The deploy platform's CDN answer to an RSC request for a route this build prerendered as a shell with placeholder params. */
function standIn(): Server {
  const manifest = JSON.parse(readFileSync(join(NEXT_DIR, "prerender-manifest.json"), "utf8")) as {
    dynamicRoutes: Record<string, { renderingMode?: string; fallback?: unknown; routeRegex: string }>;
  };
  const shells = Object.entries(manifest.dynamicRoutes)
    .filter(([, r]) => r.renderingMode === "PARTIALLY_STATIC" && r.fallback)
    .map(([route, r]) => ({ route, re: new RegExp(r.routeRegex) }));
  console.log(`info routes prerendered as shells with placeholder params: ${shells.length}`);
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const shell = req.headers.rsc === "1" ? shells.find((s) => s.re.test(url.pathname)) : undefined;
    const segment = req.headers["next-router-segment-prefetch"];
    const file = shell && join(NEXT_DIR, "server/app", `${shell.route}.segments`, typeof segment === "string" ? `${segment}.segment.rsc` : "_full.segment.rsc");
    if (file && existsSync(file)) {
      res.writeHead(200, { "content-type": "text/x-component", "x-nextjs-prerender": "1" });
      res.end(readFileSync(file));
      return;
    }
    const up = request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (u) => {
      res.writeHead(u.statusCode ?? 502, u.headers);
      u.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  }).listen(port + 1, "127.0.0.1");
}

async function until(what: string, ok: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`nav-smoke: timed out waiting for ${what}`);
}

const NOT_VALID = "This link isn't valid.";
const heading = async (page: Page) => ((await page.locator("h1").first().textContent({ timeout: 10_000 }).catch(() => null)) ?? "").trim();

async function storefront(page: Page) {
  await page.goto(`${base}/`);
  await page.getByRole("link", { name: /Hazratganj/ }).first().click();
  await page.waitForURL(/\/o\/[0-9a-f-]{36}$/);
  const add = page.getByRole("button", { name: "Add Cardamom Knot" });
  check("menu after a client navigation", await add.waitFor({ timeout: 15_000 }).then(() => true, () => false), await heading(page));
  await add.click();
  await page.getByRole("button", { name: /^Cart, \d/ }).click();
  await page.getByRole("link", { name: "Go to checkout" }).click();
  await page.waitForURL(/\/checkout$/);
  await page.locator("#f-name").fill("Nav Smoke Guest (synthetic)", { timeout: 15_000 });
  await page.locator("#f-phone").fill("9000000998");
  const place = page.getByRole("button", { name: "Place order" });
  await until("Place order to enable", () => place.isEnabled());
  await place.click();
  await page.waitForURL(/\/order\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await until("the tracker", async () => /^Order #\d+/.test(await heading(page)) || (await heading(page)) === NOT_VALID, 20_000).catch(() => undefined);
  const h = await heading(page);
  check("tracker right after checkout (router.replace)", /^Order #\d+/.test(h), h);
}

async function owner(page: Page, width: number) {
  await page.goto(`${base}/staff/sign-in`);
  await page.getByRole("button", { name: "Sign in as Nandini Mehrotra" }).click();
  await page.waitForURL(/\/staff\/home$/);
  const low = page.locator("section[aria-labelledby='low-title']");
  await low.getByRole("button", { name: "Request quotes" }).first().click({ timeout: 20_000 });
  const panel = low.getByRole("group");
  check("Request quotes offers only the owner's outlets, the shown one chosen", (await panel.getByRole("checkbox").count()) === 2 && (await panel.getByRole("checkbox", { checked: true }).count()) === 1);
  check("Request quotes wears the simulated-supplier label", await panel.getByText("Simulated supplier", { exact: true }).isVisible());
  await panel.getByRole("checkbox", { checked: false }).check();
  // Each outcome the mock is told to answer (its X-Mock-Force-Negotiation), in the words the brief and core's statuses call for;
  // consecutive outcomes differ, so waiting for each one's words never reads the one before.
  const words: Record<string, RegExp> = {
    no_shortfall: /^No shortfall yet\./, no_quote: /^No supplier could quote\./, no_passing_quote: /^Quotes came back, but none fit/,
    model_blocked: /^AI is switched off/, drafted: /^Quotes requested — a purchase order is waiting for approval\./,
  };
  for (const forced of shots ? Object.keys(words) : ["drafted"]) {
    await page.evaluate((n) => sessionStorage.setItem("munim.mock.controls", JSON.stringify({ negotiation: n })), forced);
    await panel.getByRole("button", { name: /^(Send request|Ask again)$/ }).click();
    const said = async () => ((await panel.getByRole("status").last().textContent()) ?? "").trim();
    await until(`the ${forced} outcome`, async () => words[forced]!.test(await said())).catch(() => undefined);
    check(`Request quotes: ${forced} in plain words`, words[forced]!.test(await said()), await said());
    if (shots) await page.screenshot({ path: join(shots, `request-quotes-${forced}-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => sessionStorage.removeItem("munim.mock.controls"));
  await panel.getByRole("link", { name: "Open the purchase order draft" }).click();
  await page.waitForURL(/\/staff\/inbox\/[0-9a-f-]{36}$/);
  await until("the draft", async () => (await page.getByRole("button", { name: /Approve|Reject/ }).count()) > 0, 20_000).catch(() => undefined);
  check("the purchase-order draft after a client navigation", (await page.getByRole("button", { name: /Approve|Reject/ }).count()) > 0, await heading(page));

  await page.getByRole("link", { name: "Suppliers", exact: true }).first().click();
  await page.waitForURL(/\/staff\/suppliers$/);
  const po = page.locator("a[href^='/staff/purchase-orders/']").first();
  await po.click({ timeout: 20_000 });
  await page.waitForURL(/\/staff\/purchase-orders\/[0-9a-f-]{36}$/);
  await until("the purchase order", async () => (await heading(page)) !== "", 20_000).catch(() => undefined);
  check("a purchase order after a client navigation", !/^Not found\.?$/.test(await heading(page)) && (await heading(page)) !== "", await heading(page));
  await page.goBack();
  await page.locator("a[href^='/staff/suppliers/']").first().click({ timeout: 20_000 });
  await page.waitForURL(/\/staff\/suppliers\/[0-9a-f-]{36}$/);
  await until("the supplier", async () => (await heading(page)) !== "", 20_000).catch(() => undefined);
  check("a supplier after a client navigation", !/^Not found\.?$/.test(await heading(page)) && (await heading(page)) !== "", await heading(page));

  // T-128's routes with a param in the path: an investigation and a specialist's desk, each reached by a click.
  await page.getByRole("link", { name: "Investigations", exact: true }).first().click();
  await page.waitForURL(/\/staff\/investigations$/);
  await page.locator("a[href^='/staff/investigations/']").first().click({ timeout: 20_000 });
  await page.waitForURL(/\/staff\/investigations\/[0-9a-f-]{36}$/);
  await until("the investigation", async () => (await heading(page)) !== "", 20_000).catch(() => undefined);
  check("an investigation after a client navigation", !/couldn't find|isn't valid/.test(await heading(page)) && (await heading(page)) !== "", await heading(page));
  await page.getByRole("link", { name: "The office", exact: true }).first().click();
  await page.waitForURL(/\/staff\/office$/);
  await page.locator("a[href='/staff/office/customers']").click({ timeout: 20_000 });
  await page.waitForURL(/\/staff\/office\/customers$/);
  await until("the desk", async () => (await heading(page)) !== "", 20_000).catch(() => undefined);
  check("a specialist's desk after a client navigation", (await heading(page)) === "Customers desk", await heading(page));
}

async function main() {
  if (!existsSync(join(NEXT_DIR, "BUILD_ID"))) throw new Error("nav-smoke: no production build here: run `next build` on the mock first");
  if (shots) mkdirSync(shots, { recursive: true });
  const next: ChildProcess = spawn(join("node_modules", ".bin", "next"), ["start", "-p", String(port)], { env: { ...process.env, MUNIM_MOCK: "1" }, stdio: "ignore" });
  const proxy = standIn();
  try {
    await until("next start", async () => (await fetch(`http://127.0.0.1:${port}/`)).ok);
    const browser = await chromium.launch({ executablePath: chromium.executablePath(), args: ["--headless=new"] });
    try {
      for (const width of [390, 1280]) {
        const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
        console.log(`info ${width} px wide`);
        await storefront(page);
        await owner(page, width);
        await page.context().close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    proxy.close();
    next.kill();
  }
  console.log(failed ? `nav-smoke: FAIL (${failed})` : "nav-smoke: ok");
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
