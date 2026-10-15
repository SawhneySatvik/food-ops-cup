// GET|POST /internal/cron/v1/tick — one pass of core-worker's jobs for a scheduler that calls HTTP instead of a
// long-running core-worker (a hosted cron, Cloud Scheduler). `Authorization: Bearer <MUNIM_CRON_SECRET>`,
// compared timing-safe; every refusal, and the route itself when not configured, is the same 404 (gotcha 16: a bad
// capability never says why). What runs is core-worker's own Worker.tick, handed in by the composition root: the
// same jobs as the long-running worker, as munim_svc (no book grants). Never logs the bearer.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Handler } from "hono";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv, Deps } from "../lib/types.ts";

export interface TickConfig {
  secret: string;
  /** Runs the jobs for the slot containing `now`; resolves to a JSON-safe summary (ids and labels only). */
  tick(now: Date): Promise<object>;
}

const configs = new WeakMap<Deps, TickConfig>();

/** Wires the tick route into one composed app — keyed by that exact Deps object (as configureInternal). */
export function configureTick(deps: Deps, cfg: TickConfig): void {
  if (cfg.secret.length < 16) throw new Error("configureTick: the cron secret is missing or too short");
  configs.set(deps, cfg);
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

const tick: Handler<AppEnv> = async (c) => {
  const cfg = configs.get(c.var.deps);
  if (!cfg) throw new ApiError("not_found");
  const m = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
  if (!m || !timingSafeEqual(digest(m[1]!), digest(cfg.secret))) throw new ApiError("not_found");
  return c.json(await cfg.tick(new Date()), 200);
};

export const router = new Hono<AppEnv>().get("/internal/cron/v1/tick", tick).post("/internal/cron/v1/tick", tick);
