// Per-file database: a private clone of the migrated template started by tests/global-setup.ts.
import { inject } from "vitest";
import { attachTestDb, type TestDb } from "../src/harness.ts";
import type { MigrateResult } from "../migrate.ts";
import type { SeedPacksResult } from "../seeds/packs.ts";

declare module "vitest" {
  export interface ProvidedContext {
    munimDb: { port: number; password: string; database: string; migration: MigrateResult; packs: SeedPacksResult | null };
  }
}

export async function openDb(): Promise<TestDb> {
  const { migration, packs, ...info } = inject("munimDb");
  return attachTestDb(info, { migration, packs });
}

/** Runs fn and returns the Postgres error it raised (or null). */
export async function pgError(fn: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code ?? "?", message: err.message };
  }
}
