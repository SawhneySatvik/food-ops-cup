// Worker gates (T-007): graceful shutdown of the real process entry, and the One Guarantee — the worker's
// role cannot write any book table, and the worker refuses to run as any other role.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "@munim/db";
import { Worker } from "../src/worker.ts";
import { FakeClock } from "./fake-clock.ts";
import { connString, insertOutbox, makeTenant, memLog, openDb, unpublishedCount } from "./db.ts";

let db: TestDb;
let tenant: string;

beforeAll(async () => {
  db = await openDb();
  tenant = await makeTenant(db);
});
afterAll(async () => {
  await db.stop();
});

const noDeps = {
  publisher: { publish: async () => {} },
  minter: { mint: async () => ({ run_id: "x", token: "x" }) },
  intel: { call: async () => {} },
};

describe("graceful shutdown", () => {
  it("SIGTERM mid-sweep: the claimed batch finishes and is marked, no further batch is claimed, exit 0", async () => {
    await insertOutbox(db, tenant, 150); // two claim batches (100 + 50)
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/shutdown-child.ts", import.meta.url)), connString(db, "munim_svc")],
      { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    let signalled = false;
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (!signalled && out.includes("publish:start")) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    const lines = out.trim().split("\n");
    const done = lines.filter((l) => l.startsWith("publish:done")).length;
    const { rows } = await db.admin<{ published: string; unclaimed: string }>(
      `SELECT count(*) FILTER (WHERE published_at IS NOT NULL) AS published,
              count(*) FILTER (WHERE published_at IS NULL AND claimed_until IS NULL) AS unclaimed FROM core.outbox`);
    console.log(`shutdown: exit=${code}, publish:done=${done}, marked published=${rows[0]!.published}, ` +
      `left unclaimed=${rows[0]!.unclaimed}, stopped line=${lines.find((l) => l.includes('"worker.stopped"'))}`);
    expect(signalled).toBe(true);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('"worker.stopping"'))).toBe(true);
    expect(done).toBe(100);
    expect(Number(rows[0]!.published)).toBe(100);
    expect(Number(rows[0]!.unclaimed)).toBe(50);
    expect(lines.some((l) => l.includes('"worker.stopped"') && l.includes('"clean":true'))).toBe(true);
    await db.admin("UPDATE core.outbox SET published_at = now()");
  });

  it("stop() past its timeout reports unclean and signalled the hung run to stop", async () => {
    const clock = new FakeClock("2026-10-10T00:00:30Z");
    const log = memLog();
    const w = new Worker({ connectionString: connString(db, "munim_svc"), log, clock, ...noDeps });
    let sawAbort = false;
    w.cron.add({ name: "hangs", everyMinutes: 1, run: (_s, signal) => new Promise(() => {
      signal.addEventListener("abort", () => (sawAbort = true));
    }) });
    await w.start();
    await clock.advance(30_000);
    expect(w.cron.fired.get("hangs")).toBe(1);
    expect(await w.stop(50)).toBe(false);
    expect(sawAbort).toBe(true);
    expect(log.lines.find((l) => l.event === "worker.stopped")?.fields).toEqual({ clean: false });
  });
  it("a publish that never returns (lock connection held): stop() still resolves unclean within the timeout", async () => {
    await insertOutbox(db, tenant, 5);
    const clock = new FakeClock("2026-10-10T00:00:30Z");
    const log = memLog();
    let publishCalled!: () => void;
    const called = new Promise<void>((r) => (publishCalled = r));
    const w = new Worker({ connectionString: connString(db, "munim_svc"), log, clock, ...noDeps,
      publisher: { publish: () => { publishCalled(); return new Promise<void>(() => {}); } } });
    await w.start();
    await clock.advance(30_000);
    await called;
    const t0 = Date.now();
    const result = await Promise.race([w.stop(50), new Promise<string>((r) => setTimeout(() => r("hung"), 3000))]);
    console.log(`hung publish: stop() → ${String(result)} after ${Date.now() - t0} ms`);
    expect(result).toBe(false);
    await db.admin("UPDATE core.outbox SET published_at = now()"); // leave no claimable rows for later tests
  });
});

describe("One Guarantee: the worker cannot change the books", () => {
  it("munim_svc holds no INSERT/UPDATE/DELETE on any munim:book table (munim_core does — the check can see it)", async () => {
    const q = (role: string) => db.admin<{ n: string; book: string }>(
      `SELECT count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'INSERT') OR has_table_privilege($1, c.oid, 'DELETE')
                                  OR has_table_privilege($1, c.oid, 'TRUNCATE') OR has_any_column_privilege($1, c.oid, 'INSERT')
                                  OR has_any_column_privilege($1, c.oid, 'UPDATE')) AS n,
              count(*) AS book
         FROM pg_class c
        WHERE c.relkind IN ('r', 'p') AND obj_description(c.oid, 'pg_class') = 'munim:book'`, [role]);
    const svc = (await q("munim_svc")).rows[0]!;
    const core = (await q("munim_core")).rows[0]!;
    console.log(`book tables=${svc.book}; writable by munim_svc=${svc.n}; writable by munim_core=${core.n}`);
    expect(Number(svc.book)).toBeGreaterThanOrEqual(20);
    expect(Number(svc.n)).toBe(0);
    expect(Number(core.n)).toBe(Number(core.book));
  });

  it("a write to a book table on the worker's connection fails with 42501", async () => {
    const c = new pg.Client({ connectionString: connString(db, "munim_svc") });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const err = await c.query("UPDATE core.tenant SET name = 'x' WHERE tenant_id = $1", [tenant]).then(() => null, (e: { code: string }) => e.code);
      await c.query("ROLLBACK");
      expect(err).toBe("42501");
    } finally {
      await c.end();
    }
  });

  it("the worker refuses to start as any role but munim_svc", async () => {
    const w = new Worker({ connectionString: connString(db, "munim_core"), log: memLog(), ...noDeps });
    await expect(w.start()).rejects.toThrow(/must connect as munim_svc/);
    const ok = new Worker({ connectionString: connString(db, "munim_svc"), log: memLog(), ...noDeps });
    await ok.start();
    expect(ok.cron.jobNames).toEqual(["outbox-sweep", "fanout-watch", "fanout-brief", "nightly"]);
    expect(await ok.stop(1000)).toBe(true);
  });

  it("static scan: every SQL write anywhere under src/ targets an operational table (the outbox mark is one)", async () => {
    // Recursive (src/imports/** included), comments stripped, whitespace collapsed (multi-line statements),
    // qualified or not. Each target is resolved against the live catalogue's munim:* tags — the
    // independent source: a book table, or a name that resolves to no tagged table, fails the gate.
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).sort();
    const WRITE = /\b(?<!DO\s)(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?(?:\s*\.\s*"?([a-z_][a-z0-9_]*)"?)?/gi;
    const writes: Array<{ file: string; verb: string; table: string }> = [];
    for (const f of files) {
      const text = readFileSync(dir + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, " ").replace(/\s+/g, " ");
      for (const m of text.matchAll(WRITE)) {
        writes.push({ file: f, verb: m[1]!.toUpperCase().replace(/\s+/g, " "), table: m[3] ? `${m[2]}.${m[3]}` : m[2]! });
      }
    }
    const { rows } = await db.admin<{ schema: string; name: string; tag: string }>(
      `SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid, 'pg_class') AS tag
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND obj_description(c.oid, 'pg_class') LIKE 'munim:%'`);
    // An unqualified name counts as a book write if that name is a book table in any schema.
    const tagsOf = (t: string) => rows.filter((r) => (t.includes(".") ? `${r.schema}.${r.name}` === t : r.name === t)).map((r) => r.tag);
    const verdict = writes.map((w) => {
      const tags = tagsOf(w.table);
      return { ...w, ok: tags.length > 0 && tags.every((t) => t === "munim:operational") };
    });
    console.log(`SQL writes under src/ (${files.length} files): ${verdict.length}\n  ` +
      verdict.map((v) => `${v.file}: ${v.verb} ${v.table} → ${v.ok ? "operational" : "REFUSED"}`).join("\n  "));
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(verdict.filter((v) => !v.ok)).toEqual([]);
    expect(verdict.some((v) => v.verb === "UPDATE" && v.table === "core.outbox")).toBe(true);
  });
});
