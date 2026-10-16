// node tools/worldgen/src/cli.ts --world=<name> [--as-of=YYYY-MM-DD] [--days=183] [--live-days=35] [--seed=…] [--plan]
// Live mode talks to a running core-api as personas, with their identity-provider bearer tokens:
//   MUNIM_API_URL        default http://127.0.0.1:${PORT:-8787}
//   MUNIM_SEED_TOKENS    JSON {"owner": "<jwt>", "manager": "<jwt>", …} — one token per persona the world names
//   MUNIM_SEED_TOKEN     shorthand for {"owner": "<jwt>"} (enough for worlds whose only persona is the owner)
// --plan runs the world against a fake transport and prints the request log (no server, no tokens).
// cobnut (the demo bakery behind apps/web) is a fresh tenant on every run unless --seed is given, and
// needs an "operator" token and SUPPLIERS_SIM_PUBLIC_URL (the suppliers simulator's public URL, as intel has it: its simulated suppliers'
// agent cards are <url>/{steady,discounter,premium}/.well-known/agent-card.json; refused before anything is written without it). It writes
// what the site needs under ${MUNIM_RUN_DIR:-<repo>/.run}/cobnut/ (0700; files 0600; git-ignored) and prints only the tenant id and paths:
//   storefront-key     the raw storefront key (NEXT_PUBLIC_MUNIM_STOREFRONT_KEY)
//   demo-tokens.json   {owner, manager, counter, kitchen} bearer tokens, only against a local-IdP core-api (MUNIM_DEMO_TOKENS; 1 h)
//   site.env           MUNIM_DEMO_TENANT_ID, NEXT_PUBLIC_MUNIM_STOREFRONT_KEY and (local IdP) MUNIM_DEMO_TOKENS, as KEY=value lines
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { availableWorlds, DEFAULT_SEED, loadWorld, runWorld, type WorldName } from "./run.ts";
import { businessToday } from "./time.ts";

const FLAGS = new Set(["world", "as-of", "days", "live-days", "seed", "plan"]);

function parse(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]!);
    if (!m || !FLAGS.has(m[1]!)) throw new Error(`unknown argument ${argv[i]}`);
    // `--flag value` and `--flag=value` both work; --plan takes none. A missing value (or the next flag in its place) is refused.
    const value = m[1] === "plan" ? "true" : (m[2] ?? argv[++i]);
    if (value === undefined || value === "" || (m[2] === undefined && value.startsWith("--"))) throw new Error(`--${m[1]} needs a value`);
    out.set(m[1]!, value);
  }
  return out;
}

/** The suppliers simulator's public URL from the environment: an http(s) URL, no query, credentials or fragment; no trailing slash. */
function simUrlFrom(raw: string | undefined): string {
  if (!raw) {
    throw new Error("cobnut's simulated suppliers carry agent cards on the suppliers simulator: set SUPPLIERS_SIM_PUBLIC_URL to its public URL "
      + "(the one intel has, e.g. http://127.0.0.1:8090 locally)");
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("SUPPLIERS_SIM_PUBLIC_URL is not a URL");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error("SUPPLIERS_SIM_PUBLIC_URL must be an http(s) URL with no credentials, query or fragment");
  }
  return u.toString().replace(/\/+$/, "");
}

async function main() {
  const args = parse(process.argv.slice(2));
  const world = args.get("world");
  const worlds = availableWorlds();
  if (!world || !(worlds as readonly string[]).includes(world)) throw new Error(`--world must be one of ${worlds.join(", ")}`);
  const mod = await loadWorld(world as WorldName);
  const days = Number(args.get("days") ?? 183);
  if (!Number.isInteger(days) || days < 14 || days > 400) throw new Error("--days must be a whole number from 14 to 400");
  const liveDays = args.has("live-days") ? Number(args.get("live-days")) : undefined;
  if (liveDays !== undefined && (!Number.isInteger(liveDays) || liveDays < 14 || liveDays > days)) throw new Error("--live-days must be a whole number from 14 to --days");
  const asOf = args.get("as-of") ?? businessToday(new Date(), mod.meta.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  // A reseed of cobnut must be a new tenant (its id derives from the seed), so its default seed is fresh each run.
  const seed = args.get("seed") ?? (world === "cobnut" ? `cobnut-${Date.now().toString(36)}` : DEFAULT_SEED);
  const simUrl = world === "cobnut" ? simUrlFrom(process.env.SUPPLIERS_SIM_PUBLIC_URL) : undefined;
  const sim = simUrl !== undefined ? { simUrl } : {};

  if (args.has("plan")) {
    process.stdout.write((await runWorld({ world: world as WorldName, seed, asOf, days, ...(liveDays !== undefined ? { liveDays } : {}), ...sim })).log);
    return;
  }
  const tokens: Record<string, string> = process.env.MUNIM_SEED_TOKENS ? (JSON.parse(process.env.MUNIM_SEED_TOKENS) as Record<string, string>) : {};
  if (process.env.MUNIM_SEED_TOKEN) tokens.owner ??= process.env.MUNIM_SEED_TOKEN;
  const missing = mod.meta.personas.filter((p) => !tokens[p]);
  if (missing.length) {
    throw new Error(`no bearer token for persona(s): ${missing.join(", ")}. Set MUNIM_SEED_TOKENS='{"${missing[0]}":"<jwt>",…}' `
      + "(one identity-provider ID token per persona the world names; MUNIM_SEED_TOKEN alone is the owner's).");
  }
  const baseUrl = process.env.MUNIM_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`;
  const r = await runWorld({ world: world as WorldName, seed, asOf, days, ...(liveDays !== undefined ? { liveDays } : {}), ...sim, baseUrl, token: (p) => tokens[p]!, operator: tokens.operator !== undefined });
  if (world === "cobnut") {
    const local = ((await (await fetch(new URL("/health", baseUrl))).json()) as { idp?: unknown }).idp === "local";
    const dir = join(resolve(process.env.MUNIM_RUN_DIR || join(import.meta.dirname, "../../../.run")), "cobnut");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const write = (name: string, text: string) => {
      writeFileSync(join(dir, name), text, { mode: 0o600 });
      return join(dir, name);
    };
    const key = r.state.storefrontKey;
    if (typeof key !== "string") throw new Error("cobnut: the storefront key was not returned");
    const keyFile = write("storefront-key", `${key}\n`);
    const tokenFile = local ? write("demo-tokens.json", `${JSON.stringify(Object.fromEntries(mod.meta.personas.map((p) => [p, tokens[p]])))}\n`) : null;
    const env = write("site.env", [`MUNIM_DEMO_TENANT_ID=${r.api.tenantId}`, `NEXT_PUBLIC_MUNIM_STOREFRONT_KEY=${key}`, ...(tokenFile ? [`MUNIM_DEMO_TOKENS=${tokenFile}`] : []), ""].join("\n"));
    console.log(`worldgen: cobnut seeded (${r.api.lines.length} writes, as_of=${asOf}, days=${days}); tenant ${r.api.tenantId}`);
    console.log(`          storefront key: ${keyFile}`);
    if (tokenFile) console.log(`          demo tokens (local IdP, 1 h): ${tokenFile}`);
    console.log(`          site env: ${env}`);
    console.log(`          simulated suppliers' agent cards: ${simUrl}/{steady,discounter,premium}/.well-known/agent-card.json`);
    const pricing = r.state.aiPricing as { priced: string[]; kept: string[] } | undefined;
    if (pricing) {
      console.log(`          live AI roles priced at 0 INR: ${pricing.priced.join(", ") || "none"}; already priced, left as they are: ${pricing.kept.join(", ") || "none"}`);
    }
    return;
  }
  if (tokens.operator === undefined) console.log("worldgen: no operator token, so this world is onboarded self-serve and is NOT labelled as demo data (no \"Sample data\" badge in the UI). Add \"operator\" to MUNIM_SEED_TOKENS to provision it as a demo tenant.");
  if (tokens.operator === undefined) console.log("worldgen: no operator token, so no AI budget is set for this business (with none, AI declines and rules still run). Add \"operator\" to MUNIM_SEED_TOKENS for a signed-in platform.operator.");
  console.log(`worldgen: ${world} seeded (${r.api.lines.length} writes, as_of=${asOf}, days=${days}); planted ${r.planted.length}: ${r.planted.join(" ")}`);
  // The answer-key recompute is not part of every copy of this tool (the Cup export has none).
  if (existsSync(join(import.meta.dirname, "../verify/run.ts"))) {
    console.log(`verify:   node tools/worldgen/verify/run.ts --world=${world} --as-of=${asOf}   (MUNIM_API_URL, MUNIM_SEED_TOKEN)`);
  }
}

main().catch((e: Error) => {
  console.error(`worldgen: FAIL — ${e.message}`);
  process.exit(1);
});
