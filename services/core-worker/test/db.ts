// Test plumbing: a private database clone per file, munim_svc connection strings, synthetic tenants and
// outbox rows. Every fixture write goes through a runtime role and the book guard (no superuser shortcut).
import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { attachTestDb, type TestDb } from "@munim/db";
import type { Log } from "../src/ports.ts";

declare module "vitest" {
  export interface ProvidedContext {
    workerDb: { port: number; password: string; database: string; migration: TestDb["migration"]; packs: TestDb["packs"] };
  }
}

export async function openDb(): Promise<TestDb> {
  const { migration, packs, ...info } = inject("workerDb");
  return attachTestDb(info, { migration, packs });
}

export function connString(db: TestDb, role: "munim_svc" | "munim_core"): string {
  return `postgres://${role}:${db.password}@127.0.0.1:${db.port}/${db.database}`;
}

/** UUIDv7 (contracts' id format) — run-token claims require it for tenant ids. Monotonic within a
 *  millisecond (12-bit counter in rand_a), so "first outlet" (ORDER BY created_at, id) is the first
 *  inserted even when several outlets share one transaction's created_at. */
let lastMs = 0n;
let seq = 0;
export function uuid7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Provisions a tenant (operator command, tenancy.provision.v1) with optional outlets in the given zones. */
export async function makeTenant(db: TestDb, zones: string[] = [], opts: { homeTz?: string; cutoffs?: string[] } = {}): Promise<string> {
  const tenant = uuid7();
  await db.withContext("munim_core", {
    tenant_id: tenant, outlet_ids: "*", role: "operator", operator_id: uuid7(), command_type: "tenancy.provision.v1",
  }, async (c) => {
    await c.query(`INSERT INTO core.tenant (tenant_id, name, country_code, base_currency, fy_start_month, home_tz)
                   VALUES ($1, 'Synthetic Tenant', 'IN', 'INR', 4, $2)`, [tenant, opts.homeTz ?? null]);
    for (const [i, tz] of zones.entries()) {
      await c.query(`INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address, business_day_cutoff)
                     VALUES ($1, $2, $3, 'restaurant', $4, 'Synthetic street', $5)`,
        [tenant, uuid7(), `Outlet ${i + 1}`, tz, opts.cutoffs?.[i] ?? "04:00"]);
    }
  });
  return tenant;
}

/** n unpublished outbox rows for the tenant, created `ageSeconds` ago (as munim_svc, the worker's role). */
export async function insertOutbox(db: TestDb, tenant: string, n: number, ageSeconds = 60): Promise<void> {
  await db.withContext("munim_svc", { tenant_id: tenant, role: "service" }, async (c) => {
    await c.query(
      `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload, created_at)
       SELECT $1, gen_random_uuid(), 'order', g::text, 'munim.orders.order.placed.v1', '{}'::jsonb,
              now() - make_interval(secs => $3) + make_interval(secs => g * 0.001)
         FROM generate_series(1, $2) AS g`, [tenant, n, ageSeconds]);
  });
}

/** Ids of every outbox row, ordered as the sweeper claims them. */
export async function outboxIds(db: TestDb): Promise<string[]> {
  const { rows } = await db.admin<{ id: string }>("SELECT id FROM core.outbox ORDER BY created_at, id");
  return rows.map((r) => r.id);
}

export async function unpublishedCount(db: TestDb): Promise<number> {
  const { rows } = await db.admin<{ n: string }>("SELECT count(*) AS n FROM core.outbox WHERE published_at IS NULL");
  return Number(rows[0]!.n);
}

/** A Log that keeps every line (and its serialised form, for secret scans). */
export function memLog(): Log & { lines: Array<{ event: string; fields: Record<string, unknown> }>; text: () => string } {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = ((event: string, fields: Record<string, unknown> = {}) => {
    lines.push({ event, fields });
  }) as Log & { lines: typeof lines; text: () => string };
  log.lines = lines;
  log.text = () => lines.map((l) => JSON.stringify(l)).join("\n");
  return log;
}

export function countBy(ids: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}
