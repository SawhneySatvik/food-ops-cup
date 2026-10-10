// make seed WORLD=<name>  →  node tools/worldgen/src/cli.ts --world=<name> [--as-of=YYYY-MM-DD] [--days=183] [--seed=…] [--plan]
// Live mode talks to a running core-api (`make up`) as personas, with their IdP bearer tokens:
//   MUNIM_API_URL        default http://127.0.0.1:${PORT:-8787}
//   MUNIM_SEED_TOKENS    JSON {"owner": "<jwt>", "manager": "<jwt>", …} — one token per persona the world names
//   MUNIM_SEED_TOKEN     shorthand for {"owner": "<jwt>"} (enough for worlds whose only persona is the owner)
// --plan runs the world against a fake transport and prints the request log (no server, no tokens).
import { DEFAULT_SEED, loadWorld, runWorld, WORLDS, type WorldName } from "./run.ts";
import { localDate } from "./time.ts";

const FLAGS = new Set(["world", "as-of", "days", "seed", "plan"]);

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
  const asOf = args.get("as-of") ?? localDate(new Date(), mod.meta.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("--as-of must be YYYY-MM-DD");
  const seed = args.get("seed") ?? DEFAULT_SEED;

  if (args.has("plan")) {
    process.stdout.write((await runWorld({ world: world as WorldName, seed, asOf, days })).log);
    return;
  }
  const tokens: Record<string, string> = process.env.MUNIM_SEED_TOKENS ? (JSON.parse(process.env.MUNIM_SEED_TOKENS) as Record<string, string>) : {};
  if (process.env.MUNIM_SEED_TOKEN) tokens.owner ??= process.env.MUNIM_SEED_TOKEN;
  const missing = mod.meta.personas.filter((p) => !tokens[p]);
  if (missing.length) {
    throw new Error(`no bearer token for persona(s): ${missing.join(", ")}. Set MUNIM_SEED_TOKENS='{"${missing[0]}":"<jwt>",…}'. `
      + "core-api in `make up` verifies the dev host sign-ins only (no local IdP), so each persona needs a real verified sign-in; see the T-033 report (auth gap).");
  }
  const baseUrl = process.env.MUNIM_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}`;
  const r = await runWorld({ world: world as WorldName, seed, asOf, days, baseUrl, token: (p) => tokens[p]! });
  console.log(`worldgen: ${world} seeded (${r.api.lines.length} writes, as_of=${asOf}, days=${days}); planted ${r.planted.length}: ${r.planted.join(" ")}`);
  console.log(`verify:   node tools/worldgen/verify/run.ts --world=${world} --as-of=${asOf}   (MUNIM_API_URL, MUNIM_SEED_TOKEN)`);
}

main().catch((e: Error) => {
  console.error(`worldgen: FAIL — ${e.message}`);
  process.exit(1);
});
