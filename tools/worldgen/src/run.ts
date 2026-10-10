// Runs one world against an API (or a fake one, in plan mode) and returns what was planted and the request log.
import { Api } from "./api.ts";
import { makeCtx } from "./ctx.ts";
import { dryFetch } from "./dry.ts";

export const WORLDS = ["restaurant_group", "cloud_kitchen", "store", "au_outlet"] as const;
export type WorldName = (typeof WORLDS)[number];

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
}

export async function runWorld(o: RunOptions): Promise<{ planted: string[]; log: string; api: Api }> {
  const seed = o.seed ?? DEFAULT_SEED;
  const mod = await loadWorld(o.world);
  const dry = o.baseUrl === undefined;
  const api = new Api({
    baseUrl: o.baseUrl ?? "http://plan.invalid", seed, world: o.world, token: o.token ?? (() => "plan"),
    ...(dry ? { fetch: dryFetch(mod.meta), lenient: true } : {}),
  });
  const c = makeCtx({ api, world: o.world, seed, asOf: o.asOf, days: o.days, ...(o.liveDays !== undefined ? { liveDays: o.liveDays } : {}) });
  await mod.build(c);
  return { planted: [...c.planted].sort(), log: `# world=${o.world} seed=${seed} as_of=${o.asOf} days=${o.days} live_days=${c.liveDays}\n${api.logText()}`, api };
}
