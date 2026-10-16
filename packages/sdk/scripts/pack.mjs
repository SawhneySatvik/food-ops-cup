// Builds the publishable @munim/sdk (ESM JS + .d.ts from ./src) into a stage dir, then `npm pack`s it.
//   node scripts/pack.mjs            -> apps/site/public/downloads/munim-sdk-<VERSION>.tgz + .sha256
// Every contract change ships under a new VERSION and file name; a published tarball is never overwritten, because a
// consumer's lockfile pins its integrity (R53 H-5). munim-sdk.tgz is 0.1.0, kept byte-identical for that reason.
//   node scripts/pack.mjs --out DIR  -> same, into DIR
// Reproducible: npm pins tar entry mtimes and writes no gzip timestamp, and every input is a committed file, so the same
// source gives the same sha256 (check-pack.mjs asserts it by packing twice).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(sdk, "../..");
const tsc = join(sdk, "node_modules/typescript/bin/tsc");
export const VERSION = "0.3.1";
export const FILE = `munim-sdk-${VERSION}.tgz`;

/** The only files a consumer gets; check-pack.mjs compares `npm pack --dry-run` to this list. */
export const WHITELIST = [
  "README.md",
  "dist/gen/client.d.ts",
  "dist/gen/client.js",
  "dist/gen/openapi.d.ts",
  "dist/gen/openapi.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/stream.d.ts",
  "dist/stream.js",
  "dist/uuid.d.ts",
  "dist/uuid.js",
  "package.json",
];

export function stage() {
  const src = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "munim-sdk-stage-"));
  execFileSync(process.execPath, [tsc, "-p", join(sdk, "tsconfig.build.json"), "--outDir", join(dir, "dist")], { stdio: "inherit" });
  // tsc rewrites ".ts" specifiers in emitted JS but not in .d.ts; a consumer cannot resolve "./x.ts" there.
  for (const f of readdirSync(join(dir, "dist"), { recursive: true })) {
    if (!f.endsWith(".d.ts")) continue;
    const p = join(dir, "dist", f);
    writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+")(\.[^"]*)\.ts(")/g, "$1$2.js$3"));
  }
  cpSync(join(sdk, "README.md"), join(dir, "README.md"));
  const pkg = {
    name: "@munim/sdk",
    version: VERSION,
    description: "Typed client, storefront-key auth and fetch-based SSE reader for the Munim /v1 API (synthetic data in the mock).",
    license: "UNLICENSED",
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    sideEffects: false,
    engines: { node: ">=20" },
    files: ["dist", "README.md"],
    dependencies: { "openapi-fetch": src.dependencies["openapi-fetch"] },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (process.env.MUNIM_PACK_PLANT === "stray-file") writeFileSync(join(dir, "dist/stray.js"), "export {};\n"); // red-proof seam
  return dir;
}

export function pack(dir, outDir) {
  const dest = mkdtempSync(join(tmpdir(), "munim-sdk-tgz-"));
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", dest], { cwd: dir, encoding: "utf8" });
  const file = join(dest, JSON.parse(out)[0].filename);
  mkdirSync(outDir, { recursive: true });
  const tgz = join(outDir, FILE);
  cpSync(file, tgz); // copy, not rename: tmp and the repo may be different filesystems
  const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  writeFileSync(`${tgz}.sha256`, `${sha}  ${FILE}\n`);
  rmSync(dest, { recursive: true, force: true });
  return { tgz, sha };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--out");
  const outDir = i > 0 ? resolve(process.argv[i + 1]) : join(repo, "apps/site/public/downloads");
  const dir = stage();
  const { tgz, sha } = pack(dir, outDir);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${sha}  ${tgz}`);
}
