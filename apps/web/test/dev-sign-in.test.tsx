// Dev sign-in under DNS rebinding and load: the page and its action refuse (404) any Host that is not a local name, and
// the page lists personas WITHOUT minting — a token is minted only by the POST action, for the one persona chosen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ host: "127.0.0.1:3160", minted: [] as string[] }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: state.host }),
  cookies: async () => ({ get: () => undefined, set() {}, delete() {} }),
}));
vi.mock("../lib/session/dev-local.ts", async (orig) => ({
  ...(await orig<typeof import("../lib/session/dev-local.ts")>()),
  devSignInAvailable: async () => true,
  mintPersonaTokens: async (world: string) => {
    state.minted.push(world);
    return {};
  },
}));

const { default: DevSignIn } = await import("../app/dev/sign-in/page.tsx");
const { signInAs } = await import("../app/dev/sign-in/actions.ts");
const { DEV_PERSONAS, DEV_WORLDS } = await import("../lib/session/dev-local.ts");

afterEach(() => {
  state.host = "127.0.0.1:3160";
  state.minted = [];
});

const digest = async (p: Promise<unknown>) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e);
  }
};
const form = (world: string, persona: string) => {
  const f = new FormData();
  f.set("world", world);
  f.set("persona", persona);
  return f;
};

test("a rebound host name gets a 404 from the page and the action, and nothing is minted", async () => {
  state.host = "evil.example:3160";
  expect(await digest(DevSignIn({ searchParams: Promise.resolve({}) }))).toMatch(/404/);
  expect(await digest(signInAs(form("restaurant_group", "owner")))).toMatch(/404/);
  expect(state.minted).toEqual([]);
});

test("the page lists personas on a local host without minting any token", async () => {
  for (const host of ["127.0.0.1:3160", "localhost:3161", "[::1]:3162"]) {
    state.host = host;
    const html = renderToStaticMarkup(await DevSignIn({ searchParams: Promise.resolve({ world: "restaurant_group" }) }));
    expect(html).toContain("Sign in as owner");
    expect(html).toContain("Sign in as manager");
  }
  expect(state.minted).toEqual([]);
});

test("the action mints only on POST, for the chosen world", async () => {
  expect(await digest(signInAs(form("restaurant_group", "owner")))).toMatch(/REDIRECT/);
  expect(state.minted).toEqual(["restaurant_group"]);
});

test("the static persona list matches each worldgen world's meta.personas (drift gate)", () => {
  const root = join(import.meta.dirname, "../../..");
  for (const w of DEV_WORLDS) {
    const src = readFileSync(join(root, `tools/worldgen/src/worlds/${w}.ts`), "utf8");
    const m = /export const meta = \{[^}]*personas: \[([^\]]*)\]/.exec(src);
    expect(m, w).not.toBeNull();
    expect([...DEV_PERSONAS[w]], w).toEqual([...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
  }
});
