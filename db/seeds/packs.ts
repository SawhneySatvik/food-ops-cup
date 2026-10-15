// Country-pack seed (02-schema §1; BOARD M-A). Reads the canonical pack documents owned by @munim/contracts
// (packages/contracts/packs/*.json — T-002) and inserts each (code, version) into platform.country_pack.
// Idempotent: an existing row with the identical document is left alone; an existing row with a DIFFERENT
// document is refused loudly — a published pack version is immutable; publish a new version instead.
// Schema validation of the document belongs to the app (contracts/country-pack); this script only checks
// the identity fields it keys on. Runs as the admin connection (bootstrap), never as a runtime role.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrlFromEnv } from "../migrate.ts";

export const PACKS_DIR = fileURLToPath(new URL("../../packages/contracts/packs/", import.meta.url));

export interface SeedPacksResult {
  dir: string;
  inserted: string[];
  unchanged: string[];
}

export async function seedPacks(
  client: pg.Client,
  opts: { dir?: string; log?: (l: string) => void } = {},
): Promise<SeedPacksResult> {
  const dir = opts.dir ?? PACKS_DIR;
  const log = opts.log ?? ((l: string) => console.log(l));
  const result: SeedPacksResult = { dir, inserted: [], unchanged: [] };
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^[A-Z]{2}\.json$/.test(f)).sort() : [];
  if (files.length === 0) {
    log(`seed:packs: SKIPPED — no pack documents at ${dir} (owned by @munim/contracts, T-002)`);
    return result;
  }
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    const code = doc.code;
    const version = doc.version;
    const effectiveFrom = doc.effective_from;
    if (code !== f.slice(0, 2) || !Number.isInteger(version) || typeof effectiveFrom !== "string") {
      throw new Error(`seed:packs: ${f} — code/version/effective_from missing or code does not match the file name`);
    }
    const text = JSON.stringify(doc);
    const ins = await client.query(
      `INSERT INTO platform.country_pack (code, version, effective_from, doc, status)
       VALUES ($1, $2, $3, $4::jsonb, 'active')
       ON CONFLICT (code, version) DO NOTHING RETURNING code`,
      [code, version, effectiveFrom, text],
    );
    const label = `${code}@${version}`;
    if (ins.rowCount === 1) {
      result.inserted.push(label);
      continue;
    }
    const same = await client.query(
      "SELECT doc = $3::jsonb AS same FROM platform.country_pack WHERE code = $1 AND version = $2",
      [code, version, text],
    );
    if (!same.rows[0]?.same) {
      throw new Error(`seed:packs: ${label} already exists with a different document — refusing; publish a new version`);
    }
    result.unchanged.push(label);
  }
  log(`seed:packs: inserted [${result.inserted.join(", ")}], unchanged [${result.unchanged.join(", ")}]`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = await adminUrlFromEnv("seed:packs");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await seedPacks(client);
  } finally {
    await client.end();
  }
}
