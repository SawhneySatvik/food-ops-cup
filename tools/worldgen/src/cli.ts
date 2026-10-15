// make seed WORLD=<name>  →  node tools/worldgen/src/cli.ts --world=<name> [--as-of=YYYY-MM-DD] [--days=183] [--live-days=35] [--seed=…] [--plan]
// Live mode talks to a running core-api (`make up`) as personas, with their IdP bearer tokens:
//   MUNIM_API_URL        default http://127.0.0.1:${PORT:-8787}
//   MUNIM_SEED_TOKENS    JSON {"owner": "<jwt>", "manager": "<jwt>", …} — one token per persona the world names
//   MUNIM_SEED_TOKEN     shorthand for {"owner": "<jwt>"} (enough for worlds whose only persona is the owner)
// `make seed` fills MUNIM_SEED_TOKENS itself for a core-api started with MUNIM_IDP=local (R44a) — see the Makefile and
// adapters/dev/idp-local/mint-seed-tokens.ts (worldgen's src may not spawn processes or reach adapters, gate d).
// --plan runs the world against a fake transport and prints the request log (no server, no tokens).
// cobnut (the demo bakery behind apps/web) is a fresh tenant on every run unless --seed is given, and needs an "operator" token. It writes
// what the site needs under ${MUNIM_RUN_DIR:-<repo>/.run}/cobnut/ (0700; files 0600; git-ignored) and prints only the tenant id and paths:
//   storefront-key     the raw storefront key (NEXT_PUBLIC_MUNIM_STOREFRONT_KEY)
//   demo-tokens.json   {owner, manager, counter, kitchen} bearer tokens, only against a local-IdP core-api (MUNIM_DEMO_TOKENS; 1 h)
//   site.env           MUNIM_DEMO_TENANT_ID, NEXT_PUBLIC_MUNIM_STOREFRONT_KEY and (local IdP) MUNIM_DEMO_TOKENS, as KEY=value lines
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SEED, loadWorld, runWorld, WORLDS, type WorldName } from "./run.ts";
import { businessToday } from "./time.ts";

const FLAGS = new Set(["world", "as-of", "days", "live-days", "seed", "plan"]);

function parse(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]!);
    if (!m || !FLAGS.has(m[1]!)) throw new Error(`unknown argument ${argv[i]}`);
    // `--flag value` and `--flag=value` both work; --plan takes none.
    out.set(m[1]!, m[1] === "plan" ? "true" : (m[2] ?? argv[++i] ?? ""));
  }
  return out;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const world = args.get("world");
  if (!world || !(WORLDS as readonly string[]).includes(world)) throw new Error(`--world must be one of ${WORLDS.join(", ")}`);
  const mod = await loadWorld(world as WorldName);
  const days = Number(args.get("days") ?? 183);
  if (!Number.isInteger(days) || days < 14 || days > 400) throw new Error("--days must be a whole number from 14 to 400");
  const liveDays = args.has("live-days") ? Number(args.get("live-days")) : undefined;
  if (liveDays !== undefined && (!Number.isInteger(liveDays) || liveDays < 14 || liveDays > days)) throw new Error("--live-days must be a whole number from 14 to --days");
  const asOf = args.get("as-of") ?? businessToday(new Date(), mod.meta.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  // A reseed of cobnut must be a new tenant (its id derives from the seed), so its default seed is fresh each run.
  const seed = args.get("seed") ?? (world === "cobnut" ? `cobnut-${Date.now().toString(36)}` : DEFAULT_SEED);

  if (args.has("plan")) {
    process.stdout.write((await runWorld({ world: world as WorldName, seed, asOf, days, ...(liveDays !== undefined ? { liveDays } : {}) })).log);
    return;
  }
  const tokens: Record<string, string> = process.env.MUNIM_SEED_TOKENS ? (JSON.parse(process.env.MUNIM_SEED_TOKENS) as Record<string, string>) : {};
  if (process.env.MUNIM_SEED_TOKEN) tokens.owner ??= process.env.MUNIM_SEED_TOKEN;
  const missing = mod.meta.personas.filter((p) => !tokens[p]);
  if (missing.length) {
    throw new Error(`no bearer token for persona(s): ${missing.join(", ")}. Set MUNIM_SEED_TOKENS='{"${missing[0]}":"<jwt>",…}'. `
      + "A the dev host-mode core-api needs real verified sign-ins; for the dev-only local sign-in start it with `MUNIM_IDP=local make up LOCAL_DB=1` and run `make seed` (it mints the tokens).");
  }
  const baseUrl = process.env.MUNIM_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`;
  const r = await runWorld({ world: world as WorldName, seed, asOf, days, ...(liveDays !== undefined ? { liveDays } : {}), baseUrl, token: (p) => tokens[p]!, operator: tokens.operator !== undefined });
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
    return;
  }
  if (tokens.operator === undefined) console.log("worldgen: no operator token, so this world is onboarded self-serve and is NOT labelled demo (hard rule 5: no \"Sample data\" badge in the UI). Add \"operator\" to MUNIM_SEED_TOKENS to provision it as a demo tenant.");
  if (tokens.operator === undefined) console.log("worldgen: no operator token, so no AI budget is set for this business (R47 D2: with none, AI declines and rules still run). Add \"operator\" to MUNIM_SEED_TOKENS for a signed-in platform.operator.");
  console.log(`worldgen: ${world} seeded (${r.api.lines.length} writes, as_of=${asOf}, days=${days}); planted ${r.planted.length}: ${r.planted.join(" ")}`);
  console.log(`verify:   node tools/worldgen/verify/run.ts --world=${world} --as-of=${asOf}   (MUNIM_API_URL, MUNIM_SEED_TOKEN)`);
}

main().catch((e: Error) => {
  console.error(`worldgen: FAIL — ${e.message}`);
  process.exit(1);
});
