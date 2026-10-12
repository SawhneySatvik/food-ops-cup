// Gate (T-095c, ADR-015 §8): after the pack seed, platform.country_pack holds (IN,4) and (AU,4) next to a v3 that is byte-for-byte
// unchanged. The v3 side comes from the committed fixtures (the packs as they were), the v4 side from packs/*.json; the
// assertion reads the table. Real migrations on embedded Postgres, no mocks.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../../../db/src/harness.ts";
import { seedPacks } from "../../../db/seeds/packs.ts";
import { CountryPack } from "../src/packs/index.ts";
import { PKG } from "./helpers.ts";

const fixture = (c: string) => JSON.parse(readFileSync(join(PKG, "test", "fixtures", `${c}.v3.json`), "utf8"));
let db: TestDb;
beforeAll(async () => {
  db = await startTestDb({ seedPacks: false });
}, 240_000);
afterAll(async () => {
  await db?.stop();
});

describe("country-pack seed: v3 then v4", () => {
  it("(IN,4) and (AU,4) land beside an unchanged (IN,3) and (AU,3); re-seeding is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-packs-v3-"));
    mkdirSync(dir, { recursive: true });
    for (const c of ["IN", "AU"]) writeFileSync(join(dir, `${c}.json`), JSON.stringify(fixture(c)));
    const c = await db.connect("admin");
    try {
      const v3 = await seedPacks(c, { dir, log: () => {} });
      expect(v3.inserted).toEqual(["AU@3", "IN@3"]);
      const before = await db.admin("SELECT code, version, doc FROM platform.country_pack ORDER BY code, version");

      const v4 = await seedPacks(c, { log: () => {} });
      expect(v4.inserted).toEqual(["AU@4", "IN@4"]);
      expect(v4.unchanged).toEqual([]);

      const rows = await db.admin<{ code: string; version: number; doc: Record<string, unknown> }>("SELECT code, version, doc FROM platform.country_pack ORDER BY code, version");
      expect(rows.rows.map((r) => `${r.code}@${r.version}`)).toEqual(["AU@3", "AU@4", "IN@3", "IN@4"]);
      // v3 rows are exactly what they were, and exactly the fixture
      expect(rows.rows.filter((r) => r.version === 3)).toEqual(before.rows);
      for (const r of rows.rows.filter((x) => x.version === 3)) expect(r.doc).toEqual(fixture(r.code));
      // v4 rows parse and carry the cares block; v3 rows have none
      for (const r of rows.rows.filter((x) => x.version === 4)) expect(CountryPack.parse(r.doc).cares?.cooked_max_hold_min).toBe(120);
      for (const r of rows.rows.filter((x) => x.version === 3)) expect("cares" in r.doc).toBe(false);

      const again = await seedPacks(c, { log: () => {} });
      expect([again.inserted, again.unchanged.sort()]).toEqual([[], ["AU@4", "IN@4"]]);
    } finally {
      await c.end();
    }
  }, 240_000);
});
