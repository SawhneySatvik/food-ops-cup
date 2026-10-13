"use server";
// Dev sign-in (R44a): mint the persona's local-IdP token, pick its business, set the session cookies. Re-checks the dev
// guard itself — a server action is reachable by POST whether or not the page rendered.
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { serverClient } from "../../../lib/core.ts";
import { DEV_WORLDS, devSignInAvailable, mintPersonaTokens, type DevWorld } from "../../../lib/session/dev-local.ts";
import { COOKIE, cookieOptions } from "../../../lib/session/index.ts";

export async function signInAs(form: FormData): Promise<void> {
  if (!(await devSignInAvailable())) notFound();
  const world = String(form.get("world"));
  const persona = String(form.get("persona"));
  if (!(DEV_WORLDS as readonly string[]).includes(world)) notFound();
  const token = (await mintPersonaTokens(world as DevWorld))[persona];
  if (!token) redirect(`/dev/sign-in?world=${world}&failed=1`);
  const { data } = await serverClient(token).GET("/v1/me/tenants");
  const tenant = data?.tenants[0];
  if (!tenant) redirect(`/dev/sign-in?world=${world}&failed=1`);
  const jar = await cookies();
  jar.set(COOKIE.token, token, cookieOptions(3600));
  jar.set(COOKIE.tenant, tenant.tenant_id, cookieOptions());
  jar.set(COOKIE.scope, "all", cookieOptions());
  jar.set(COOKIE.devPersona, `${world}:${persona}`, cookieOptions());
  redirect("/console");
}
