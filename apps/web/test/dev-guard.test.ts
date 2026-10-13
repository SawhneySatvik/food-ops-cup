// The dev sign-in exists only when NODE_ENV is not production AND core's /health reports idp "local". core is mocked at
// its HTTP boundary (global fetch); the minter script must exist in the repo.
import { afterEach, expect, test, vi } from "vitest";
import { devSignInAvailable } from "../lib/session/dev-local.ts";

const health = (idp: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", idp }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("available on a dev server whose core reports idp local", async () => {
  vi.stubEnv("MUNIM_REPO_ROOT", `${import.meta.dirname}/../../..`);
  health("local");
  expect(await devSignInAvailable()).toBe(true);
});

test("refused when core runs a real IdP", async () => {
  vi.stubEnv("MUNIM_REPO_ROOT", `${import.meta.dirname}/../../..`);
  health("devhost");
  expect(await devSignInAvailable()).toBe(false);
});

test("refused when core cannot be reached", async () => {
  vi.stubEnv("MUNIM_REPO_ROOT", `${import.meta.dirname}/../../..`);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  expect(await devSignInAvailable()).toBe(false);
});

test("refused in production even when core reports local", async () => {
  vi.stubEnv("MUNIM_REPO_ROOT", `${import.meta.dirname}/../../..`);
  vi.stubEnv("NODE_ENV", "production");
  const f = health("local");
  expect(await devSignInAvailable()).toBe(false);
  expect(f).not.toHaveBeenCalled();
});
