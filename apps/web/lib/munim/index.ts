// lib/munim/index.ts: from 01-api-client.md
// The one client instance the app uses. Switching mock -> real API is two env vars; no code changes.
import { createMunimClient } from "./client";
import { mockHeaders } from "./mock-controls";

/** Defaults to this app's own mock at /mock (mock-server/). */
export const API_BASE = (process.env.NEXT_PUBLIC_MUNIM_API || "/mock").replace(/\/+$/, "");
export const STOREFRONT_KEY = process.env.NEXT_PUBLIC_MUNIM_STOREFRONT_KEY ?? "";
/** True when the base URL is the mock (its path ends in /mock). Test switches are sent only then. */
export const IS_MOCK = /\/mock$/.test(API_BASE);

export const munim = createMunimClient({
  baseUrl: API_BASE,
  storefrontKey: STOREFRONT_KEY,
  extraHeaders: IS_MOCK ? mockHeaders : undefined,
});
