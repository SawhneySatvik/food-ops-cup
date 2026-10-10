// Module discovery for the generators and tests. Every directory `src/<module>/` with an `index.ts` is a
// contracts module exporting `SCHEMAS` (name → zod) and `ROUTES`. A new module ticket adds its own
// directory (+ MANIFEST.d/<module>.txt) and is picked up here without editing any shared file.
// MANIFEST.d is never read here: it is the tests' independent, hand-kept expectation.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import type { ModuleContracts, Route } from "./shared/routes.ts";

export const SRC = import.meta.dirname;

export type Registry = {
  modules: string[];
  /** [contract name, schema, module], sorted by module then declaration order. */
  schemas: Array<readonly [string, z.ZodType, string]>;
  routes: Route[];
};

/** Class / component name: "orders.place.v1" → "OrdersPlaceV1". */
export function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}

/** Throws on a repeated operationId or a repeated "METHOD path" (path parameters compared as `{}`, so `{id}` and
 *  `{order_id}` collide). Last-wins in the generator's `paths` map would otherwise hide the loser (R3-m1). */
export function assertUniqueRoutes(routes: readonly Route[]): void {
  const ops = new Set<string>();
  const keys = new Map<string, string>();
  for (const r of routes) {
    if (ops.has(r.operationId)) throw new Error(`duplicate operationId '${r.operationId}'`);
    ops.add(r.operationId);
    const key = `${r.method.toUpperCase()} ${r.path.replace(/\{[^}]+\}/g, "{}")}`;
    const prev = keys.get(key);
    if (prev) throw new Error(`route ${key} is declared by both '${prev}' and '${r.operationId}'`);
    keys.set(key, r.operationId);
  }
}

export function moduleNames(): string[] {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SRC, d.name, "index.ts")))
    .map((d) => d.name)
    .sort();
}

export async function loadRegistry(): Promise<Registry> {
  const modules = moduleNames();
  const schemas: Registry["schemas"][number][] = [];
  const routes: Route[] = [];
  const owner = new Map<string, string>();
  const byPascal = new Map<string, string>();
  const bySchema = new Map<z.ZodType, string>();
  for (const m of modules) {
    const mod = (await import(pathToFileURL(join(SRC, m, "index.ts")).href)) as Partial<ModuleContracts>;
    if (!mod.SCHEMAS || !mod.ROUTES) throw new Error(`contracts module '${m}' must export SCHEMAS and ROUTES`);
    for (const [name, schema] of Object.entries(mod.SCHEMAS)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`contract name '${name}' (${m}) is not [a-z0-9._-]`);
      const prev = owner.get(name);
      if (prev) throw new Error(`contract name '${name}' is defined by both '${prev}' and '${m}'`);
      owner.set(name, m);
      const p = pascal(name);
      const clash = byPascal.get(p);
      if (clash) throw new Error(`contract names '${clash}' and '${name}' both map to class name '${p}'`);
      byPascal.set(p, name);
      const same = bySchema.get(schema);
      if (same) throw new Error(`contract names '${same}' and '${name}' are the same zod object; each name needs its own schema`);
      bySchema.set(schema, name);
      schemas.push([name, schema, m] as const);
    }
    routes.push(...mod.ROUTES);
  }
  for (const r of routes) {
    for (const ref of [r.request, r.command, r.response]) {
      if (ref !== undefined && !owner.has(ref)) throw new Error(`route ${r.operationId} names unknown schema '${ref}'`);
    }
  }
  // Every registered draftable publishes its proposal schema under `proposal.<type>` (and it is that object).
  const { draftable, draftableTypes } = await import("./shared/draftables.ts");
  for (const t of draftableTypes()) {
    const hit = schemas.find(([n]) => n === `proposal.${t}`);
    if (!hit || hit[1] !== draftable(t)!.proposal) throw new Error(`draftable '${t}' must publish SCHEMAS['proposal.${t}'] = its .proposal`);
  }
  assertUniqueRoutes(routes);
  return { modules, schemas, routes };
}
