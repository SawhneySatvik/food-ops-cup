// dev-local token source (R44a): personas of a seeded world, signed by the local IdP that a `MUNIM_IDP=local` core
// trusts. apps/web may not import adapters/ or tools/ (dependency-cruiser `web-imports-only-public-packages`, and
// `adapters-dev-only-from-dev-root` sees dynamic imports too), so this runs the existing dev minter as a separate
// process — the same script and run-dir choice `make seed` uses. That script refuses unless core's /health reports
// idp "local"; this module also refuses in production and re-checks /health itself. Tokens are held in memory and the
// httpOnly cookie only: never logged, never put in an error.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cookies } from "next/headers";
import { coreIdp, coreUrl } from "../core.ts";
import { COOKIE, cookieOptions, tokenClaims, type TokenSource } from "./port.ts";

/** The dev worlds `make seed` / `make demo` know (Makefile); the minter validates the name again. */
export const DEV_WORLDS = ["restaurant_group", "cloud_kitchen", "store", "au_outlet"] as const;
export type DevWorld = (typeof DEV_WORLDS)[number];
/** Each world's sign-in personas (worldgen `meta.personas`), listed without minting; test/dev-sign-in.test.tsx fails if
 *  this drifts from tools/worldgen/src/worlds/<world>.ts. */
export const DEV_PERSONAS: Readonly<Record<DevWorld, readonly string[]>> = {
  restaurant_group: ["owner", "manager"],
  cloud_kitchen: ["owner", "cashier", "manager"],
  store: ["owner"],
  au_outlet: ["owner"],
};

const repoRoot = () => resolve(process.env.MUNIM_REPO_ROOT || join(process.cwd(), "../.."));
const minter = () => join(repoRoot(), "adapters/dev/idp-local/mint-seed-tokens.ts");
// Makefile `seed`: the LOCAL_DB server keeps its key under .run/local, the hosted-dev server under .run.
const runDir = () => (existsSync(join(repoRoot(), ".run/local/local-db.json")) ? join(repoRoot(), ".run/local") : join(repoRoot(), ".run"));

/** True only on a non-production server whose core runs the local IdP. Every dev sign-in path checks it. */
export async function devSignInAvailable(): Promise<boolean> {
  if (process.env.NODE_ENV === "production") return false;
  if (!existsSync(minter())) return false;
  return (await coreIdp()) === "local";
}

/** {persona: token} for a world, minted by the dev minter. Throws a generic error (no output echoed) on refusal. */
export async function mintPersonaTokens(world: DevWorld): Promise<Record<string, string>> {
  if (!(await devSignInAvailable())) throw new Error("dev sign-in is not available");
  const stdout = await new Promise<string>((ok, fail) => {
    execFile(process.execPath, [minter(), `--world=${world}`, `--url=${coreUrl()}`, `--run-dir=${runDir()}`],
      { cwd: repoRoot(), timeout: 30_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: process.env.NODE_ENV } },
      (err, out) => (err ? fail(new Error("dev token minter refused")) : ok(out)));
  });
  const tokens = JSON.parse(stdout) as Record<string, string>;
  delete tokens.operator;
  return tokens;
}

const fresh = (token: string | undefined) => !!token && (tokenClaims(token).exp ?? 0) * 1000 > Date.now() + 60_000;

export const devLocal: TokenSource = {
  id: "dev-local",
  signInPath: "/dev/sign-in",
  async bearer() {
    const jar = await cookies();
    const token = jar.get(COOKIE.token)?.value;
    if (fresh(token)) return token!;
    // Expired or expiring: re-mint for the same persona (local IdP tokens live an hour).
    const persona = jar.get(COOKIE.devPersona)?.value?.split(":");
    if (!persona || persona.length !== 2 || !(DEV_WORLDS as readonly string[]).includes(persona[0]!)) return null;
    let next: string | undefined;
    try {
      next = (await mintPersonaTokens(persona[0] as DevWorld))[persona[1]!];
    } catch {
      return null;
    }
    if (!next) return null;
    try {
      jar.set(COOKIE.token, next, cookieOptions(3600));
    } catch {
      // Server components cannot set cookies; the next route handler or action will.
    }
    return next;
  },
};
