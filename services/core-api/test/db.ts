import { attachTestDb, type TestDb } from "@munim/db";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    munimDb: Pick<TestDb, "port" | "password" | "database" | "migration" | "packs">;
  }
}

/** A private clone of the run's migrated database. */
export async function openDb(): Promise<TestDb> {
  const { migration, packs, ...info } = inject("munimDb");
  return attachTestDb(info, { migration, packs });
}
