// Ontology freshness (gotcha 13): ontology.json records a sha256 of every input the generator reads — the migration
// files it applies, the contracts sources (draftables, registry, transform) and the generator itself — and of its own
// body. The freshness gate recomputes both; an edited migration or contract without `make ontology` is red.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const REPO = join(import.meta.dirname, "..", "..", "..", "..");
export const ONTOLOGY_FILE = join(REPO, "packages", "contracts", "generated", "ontology.json");
/** Relative to the repo root. */
export const ONTOLOGY_INPUTS = ["db/migrations", "packages/contracts/src", "packages/contracts/scripts/ontology.ts", "packages/contracts/package.json"];

function walk(p: string): string[] {
  if (!existsSync(p)) return [];
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p).flatMap((n) => (n === ".DS_Store" ? [] : walk(join(p, n))));
}

export type InputDigest = { sha256: string; files: Record<string, string> };

export function inputsDigest(root = REPO): InputDigest {
  const files = ONTOLOGY_INPUTS.flatMap((p) => walk(join(root, p))).map((f) => relative(root, f)).sort();
  const all = createHash("sha256");
  const per: Record<string, string> = {};
  for (const f of files) {
    per[f] = createHash("sha256").update(readFileSync(join(root, f))).digest("hex");
    all.update(`${f}\0${per[f]}\n`);
  }
  return { sha256: all.digest("hex"), files: per };
}

/** sha256 of the document without its `stamp` (the serialisation the generator writes). */
export function bodyDigest(doc: Record<string, unknown>): string {
  const { stamp: _s, ...body } = doc;
  return createHash("sha256").update(JSON.stringify(body, null, 2)).digest("hex");
}
