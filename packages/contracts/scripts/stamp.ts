// Generation stamp: a hash of everything `gen` reads (zod sources + generator scripts + the package
// manifest that pins the generator tools) and of everything it writes. Recorded at gen time in
// generated/sources.sha256.json; recomputed by the stale-generation test.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const PKG = join(import.meta.dirname, "..");
export const REPO = join(PKG, "..", "..");
export const STAMP_FILE = join(PKG, "generated", "sources.sha256.json");

/** Inputs, relative to the package. */
const INPUTS = ["src", "scripts", "package.json"];
/** Outputs, relative to the repo root (the stamp file itself is excluded). */
export const OUTPUT_DIRS = [
  "packages/contracts/generated/json-schema",
  "packages/contracts/generated/openapi",
  "packages/sdk/src/gen",
  "services/intel/munim_intel/contracts_gen",
];

function walk(p: string): string[] {
  if (!existsSync(p)) return [];
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p).flatMap((n) => (n === "__pycache__" || n === ".DS_Store" ? [] : walk(join(p, n))));
}

export type Digest = { sha256: string; files: Record<string, string> };

function digest(base: string, paths: string[]): Digest {
  const files = paths.flatMap((p) => walk(join(base, p))).map((f) => relative(base, f)).sort();
  const all = createHash("sha256");
  const per: Record<string, string> = {};
  for (const f of files) {
    per[f] = createHash("sha256").update(readFileSync(join(base, f))).digest("hex");
    all.update(`${f}\0${per[f]}\n`);
  }
  return { sha256: all.digest("hex"), files: per };
}

export const sourcesDigest = (): Digest => digest(PKG, INPUTS);
export const outputsDigest = (): Digest => digest(REPO, OUTPUT_DIRS);
export type Stamp = { sources: Digest; outputs: Digest };
