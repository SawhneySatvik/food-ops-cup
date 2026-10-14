// Gates for the packed SDK. Exit 1 on any failure.
//  1. `npm pack --dry-run` lists exactly WHITELIST.
//  2. Every SDK symbol README.md mentions exists in the built dist/index.d.ts.
//  3. Packing twice gives the same sha256 and the shipped tarball (if present) matches its .sha256 file.
// Test seams for red-proofs: MUNIM_PACK_PLANT=stray-file (pack.mjs), --readme FILE (check another README).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE, pack, stage, WHITELIST } from "./pack.mjs";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(sdk, "package.json"))("typescript");
const ri = process.argv.indexOf("--readme");
const readme = readFileSync(ri > 0 ? resolve(process.argv[ri + 1]) : join(sdk, "README.md"), "utf8");
const failures = [];
const fail = (m) => failures.push(m);

const dir = stage();
try {
  // 1. file list
  const dry = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" }));
  const got = dry[0].files.map((f) => f.path).sort();
  const want = [...WHITELIST].sort();
  if (want.length !== 12) fail(`whitelist has ${want.length} entries, expected 12`);
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`pack file list differs.\n  got:  ${got.join(" ")}\n  want: ${want.join(" ")}`);

  // 2. README symbols against dist/index.d.ts
  const program = ts.createProgram([join(dir, "dist/index.d.ts")], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, typeRoots: [] });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(join(dir, "dist/index.d.ts"));
  const exported = new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(sf)).map((s) => s.name));
  if (exported.size < 20) fail(`only ${exported.size} exports found in index.d.ts; the check cannot see the API`);
  const mentioned = new Set();
  for (const m of readme.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@munim\/sdk"/g)) m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean).forEach((s) => mentioned.add(s));
  for (const m of readme.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)(?:\([^`]*\))?`/g)) mentioned.add(m[1]);
  // Backticked words that are not SDK symbols (fields, headers' values, web/platform names, keywords).
  const notSdk = new Set(["EventSource", "fetch", "token", "guestToken", "storefrontKey", "baseUrl", "topics", "headers", "data", "error", "response",
    "qty_milli", "preview_total_minor", "total_minor", "guest_access_token", "reason_code", "code", "command_id", "idempotency_key", "type", "payload",
    "idempotency_conflict", "window_full", "transpilePackages", "openapi", "INR", "AUD", "randomUUID", "crypto", "undefined", "done", "close"]);
  const unknown = [...mentioned].filter((s) => !notSdk.has(s) && !exported.has(s));
  if (unknown.length) fail(`README mentions symbols missing from dist/index.d.ts: ${unknown.join(", ")}`);
  const covered = [...mentioned].filter((s) => exported.has(s));
  if (covered.length < 15) fail(`README references only ${covered.length} real SDK symbols; expected at least 15`);

  // 3. reproducibility + shipped tarball
  const a = pack(dir, join(dir, "out-a"));
  const b = pack(dir, join(dir, "out-b"));
  if (a.sha !== b.sha) fail(`pack is not reproducible: ${a.sha} vs ${b.sha}`);
  const shipped = resolve(sdk, `../../apps/site/public/downloads/${FILE}`);
  if (existsSync(shipped)) {
    const sha = createHash("sha256").update(readFileSync(shipped)).digest("hex");
    if (!readFileSync(`${shipped}.sha256`, "utf8").startsWith(sha)) fail(`shipped tarball does not match ${FILE}.sha256`);
    if (sha !== a.sha) fail(`shipped tarball is stale: ${sha} vs fresh build ${a.sha}`);
  }
  console.log(`files: ${got.length}  exports: ${exported.size}  readme symbols checked: ${covered.length}  sha256: ${a.sha}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`check-pack FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("check-pack OK");
