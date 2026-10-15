// What a world builder gets: the API, the timeline, a seeded PRNG scoped to the world, and the planted ledger.
import { Api, type J } from "./api.ts";
import { Prng } from "./prng.ts";

export interface Ctx {
  api: Api;
  world: string;
  seed: string;
  /** Outlet-local "today": the last day of the timeline. */
  asOf: string;
  /** Days of history ending at asOf (14 for the smallest profile, 183 for the full six months). */
  days: number;
  /** How far back the legs that are still live commands reach (attendance, rosters, temperature readings): history kinds for them do not exist
   *  yet (R44b), and each is one request per row. At least 14 (the planted window), at most `days`. */
  liveDays: number;
  rng: Prng;
  /** Records that problem `id` of the answer key was planted (called at the moment it is written). */
  plant(id: string): void;
  readonly planted: Set<string>;
  /** Things a builder wants to hand to later steps (channel ids, outlet ids …). */
  readonly s: Record<string, unknown>;
  /** The suppliers simulator's public URL (as intel holds it, SUPPLIERS_SIM_PUBLIC_URL), for the simulated suppliers' agent cards
   *  (cobnut). No trailing slash. */
  simUrl?: string;
}

export type { J };

export function makeCtx(o: { api: Api; world: string; seed: string; asOf: string; days: number; liveDays?: number; simUrl?: string }): Ctx {
  const planted = new Set<string>();
  return {
    ...o,
    liveDays: Math.max(14, Math.min(o.days, o.liveDays ?? 35)),
    rng: new Prng(o.seed, o.world),
    planted,
    plant(id) {
      if (planted.has(id)) throw new Error(`problem ${id} planted twice`);
      planted.add(id);
    },
    s: {},
  };
}
