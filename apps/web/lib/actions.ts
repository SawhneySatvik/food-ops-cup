"use server";
// Server actions shared by every surface: theme, scope and sign-out. Cookies only; nothing here writes the books.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE, cookieOptions, tokenSource } from "./session/index.ts";

const YEAR = 365 * 24 * 3600;

export async function setTheme(value: string): Promise<void> {
  const jar = await cookies();
  if (value === "light" || value === "dark") jar.set(COOKIE.theme, value, cookieOptions(YEAR));
  else jar.delete(COOKIE.theme);
}

/** "all" or an outlet id; core intersects every query with the member's own scope, so a forged id reads nothing. */
export async function setScope(value: string): Promise<void> {
  if (value !== "all" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return;
  (await cookies()).set(COOKIE.scope, value, cookieOptions(YEAR));
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  for (const name of [COOKIE.token, COOKIE.tenant, COOKIE.scope, COOKIE.devPersona]) jar.delete(name);
  redirect(tokenSource.signInPath);
}
