// What src/cli.ts offers and prints, with no server: the worlds it will run are the worlds whose module file is present (a
// trimmed copy, such as the Cup export's, refuses the others cleanly instead of failing on an import), and nothing it prints
// names an internal id or a command this tool's own copy may not have. Expected lists come from the directory, not from the code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { availableWorlds, WORLDS } from "../src/run.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const SIM = { SUPPLIERS_SIM_PUBLIC_URL: "http://127.0.0.1:4423" };
/** A ticket or ledger id, the build's rule numbers, a gotcha, a make target or a dev adapter path: none belongs in a message a user reads. */
const INTERNAL = /\bR[0-9]{2}\b|\bT-[0-9]{3}\b|hard rule|gotcha|\bmake\b|adapters\//i;

function run(cli: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((ok) => {
    const e = { ...process.env, ...env } as Record<string, string | undefined>;
    delete e.NODE_TEST_CONTEXT;
    delete e.MUNIM_SEED_TOKENS;
    delete e.MUNIM_SEED_TOKEN;
    const p = spawn(process.execPath, [cli, ...args], { env: e });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => ok({ code, out, err }));
  });
}

/** The tool's src/ with only `keep` among the worlds, beside a link to the repository's packages (the two places its relative imports reach). */
function trimmedCopy(keep: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "worldgen-trim-"));
  cpSync(SRC, join(dir, "tools/worldgen/src"), { recursive: true });
  symlinkSync(join(ROOT, "../../packages"), join(dir, "packages"));
  for (const f of readdirSync(join(dir, "tools/worldgen/src/worlds"))) {
    if (!keep.includes(f.replace(/\.ts$/, ""))) rmSync(join(dir, "tools/worldgen/src/worlds", f));
  }
  return dir;
}

describe("cli: worlds and messages", () => {
  test("availableWorlds lists exactly the worlds whose module file is present, in the CLI's order", () => {
    const dir = mkdtempSync(join(tmpdir(), "worldgen-worlds-"));
    try {
      assert.deepEqual(availableWorlds(dir), []);
      mkdirSync(dir, { recursive: true });
      for (const w of ["cobnut", "store", "not_a_world"]) writeFileSync(join(dir, `${w}.ts`), "");
      assert.deepEqual(availableWorlds(dir), ["store", "cobnut"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const files = readdirSync(join(SRC, "worlds")).map((f) => f.replace(/\.ts$/, ""));
    assert.deepEqual(availableWorlds(), WORLDS.filter((w) => files.includes(w)));
    assert.ok(availableWorlds().includes("cobnut"));
  });

  test("an unknown world is refused (exit 1) with the list of the worlds this copy has", async () => {
    const r = await run(join(SRC, "cli.ts"), ["--world=nope"]);
    assert.equal(r.code, 1);
    assert.equal(r.out, "");
    assert.ok(r.err.includes(`--world must be one of ${availableWorlds().join(", ")}\n`), r.err);
  });

  test("a copy without the evaluation worlds runs cobnut and refuses the others cleanly, not on an import", async () => {
    const dir = trimmedCopy(["cobnut"]);
    try {
      const cli = join(dir, "tools/worldgen/src/cli.ts");
      const store = await run(cli, ["--world=store"]);
      assert.equal(store.code, 1);
      assert.ok(store.err.includes("--world must be one of cobnut\n"), store.err);
      assert.doesNotMatch(store.err, /Cannot find module|ERR_MODULE_NOT_FOUND/);
      const cobnut = await run(cli, ["--world=cobnut", "--as-of=2026-10-10", "--days=14", "--plan"], SIM);
      assert.equal(cobnut.code, 0, cobnut.err);
      assert.match(cobnut.out, /^# world=cobnut /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing sign-in token is refused before anything is written, in words that name only what this tool takes", async () => {
    const r = await run(join(SRC, "cli.ts"), ["--world=cobnut", "--as-of=2026-10-10", "--days=14"], { ...SIM, MUNIM_API_URL: "http://127.0.0.1:9" });
    assert.equal(r.code, 1);
    assert.match(r.err, /no bearer token for persona\(s\): owner, /);
    assert.match(r.err, /MUNIM_SEED_TOKENS='\{"owner":"<jwt>",…\}'/);
    assert.doesNotMatch(r.err, INTERNAL);
  });

  test("cli.ts prints nothing that names an internal id, a make target or a development adapter", () => {
    const printed = readFileSync(join(SRC, "cli.ts"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    assert.match(printed, /console\.log\(/, "the scan sees the printing code");
    assert.doesNotMatch(printed, INTERNAL);
  });
});
