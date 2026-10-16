// Runs one world against an API (or a fake one, in plan mode) and returns what was planted and the request log.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Api } from "./api.ts";
import { makeCtx } from "./ctx.ts";
import { dryFetch } from "./dry.ts";
import { completeOnboarding } from "./kit.ts";

/** The eval worlds: each has an answer key, a recompute and the determinism gates (the tests iterate these). */
export const EVAL_WORLDS = ["restaurant_group", "cloud_kitchen", "store", "au_outlet"] as const;
/** Every world the CLI knows: the eval worlds and `cobnut`, the demo bakery behind apps/web (no answer key; cli.ts reseeds it fresh). */
export const WORLDS = [...EVAL_WORLDS, "cobnut"] as const;
export type WorldName = (typeof WORLDS)[number];

/** The worlds whose module file is present. A trimmed copy of this tool (the Cup export carries cobnut only) offers just those. */
export const availableWorlds = (dir: string = join(import.meta.dirname, "worlds")): WorldName[] => WORLDS.filter((w) => existsSync(join(dir, `${w}.ts`)));

export const DEFAULT_SEED = "munim-worldgen-v1";

export interface WorldModule {
  meta: { tz: string; currency: string; personas: readonly string[] };
  build(c: ReturnType<typeof makeCtx>): Promise<void>;
}

export const loadWorld = async (world: WorldName): Promise<WorldModule> => (await import(`./worlds/${world}.ts`)) as WorldModule;

export interface RunOptions {
  world: WorldName;
  seed?: string;
  /** Outlet-local "today". */
  asOf: string;
  /** 14 = the gate profile; 183 ≈ six months. */
  days: number;
  /** Reach of the live-command legs (default 35): see Ctx.liveDays. */
  liveDays?: number;
  /** Real API: its base URL and a bearer token per persona. Omit both for plan mode. */
  baseUrl?: string;
  token?: (persona: string) => string | Promise<string>;
  /** Real API: an operator can approve platform config (token for persona "operator" and a platform.operator row). */
  operator?: boolean;
  /** The suppliers simulator's public URL (cobnut's simulated suppliers' agent cards; cli.ts reads SUPPLIERS_SIM_PUBLIC_URL). */
  simUrl?: string;
}

/** `state` is what the world handed on (Ctx.s), e.g. cobnut's storefront key for cli.ts to write out. */
export async function runWorld(o: RunOptions): Promise<{ planted: string[]; log: string; api: Api; state: Record<string, unknown> }> {
  const seed = o.seed ?? DEFAULT_SEED;
  const mod = await loadWorld(o.world);
  const dry = o.baseUrl === undefined;
  const api = new Api({
    baseUrl: o.baseUrl ?? "http://plan.invalid", seed, world: o.world, token: o.token ?? (() => "plan"),
    ...(dry ? { fetch: dryFetch(mod.meta), lenient: true } : {}),
    ...(o.operator ? { operator: true } : {}),
  });
  const c = makeCtx({ api, world: o.world, seed, asOf: o.asOf, days: o.days, ...(o.liveDays !== undefined ? { liveDays: o.liveDays } : {}),
    ...(o.simUrl !== undefined ? { simUrl: o.simUrl } : {}) });
  await mod.build(c);
  await completeOnboarding(c);
  return { planted: [...c.planted].sort(), log: `# world=${o.world} seed=${seed} as_of=${o.asOf} days=${o.days} live_days=${c.liveDays}\n${api.logText()}`, api, state: c.s };
}
