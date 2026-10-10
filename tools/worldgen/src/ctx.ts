// What a world builder gets: the API, the timeline, a seeded PRNG scoped to the world, and the planted ledger.
import { Api, type J } from "./api.ts";
import { Prng } from "./prng.ts";

export interface Ctx {
  api: Api;
  world: string;
  seed: string;
  /** Outlet-local "today": the last day of the timeline. */
  asOf: string;
  /** Days of history ending at asOf (14 for the gate profile, 183 for the full six months). */
  days: number;
  rng: Prng;
  /** Records that problem `id` of the answer key was planted (called at the moment it is written). */
  plant(id: string): void;
  readonly planted: Set<string>;
  /** Things a builder wants to hand to later steps (channel ids, outlet ids …). */
  readonly s: Record<string, unknown>;
}

export type { J };

export function makeCtx(o: { api: Api; world: string; seed: string; asOf: string; days: number }): Ctx {
  const planted = new Set<string>();
  return {
    ...o,
    rng: new Prng(o.seed, o.world),
    planted,
    plant(id) {
      if (planted.has(id)) throw new Error(`problem ${id} planted twice`);
      planted.add(id);
    },
    s: {},
  };
}
