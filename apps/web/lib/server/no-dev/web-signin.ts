// `@munim-dev/web-signin` in a build without a development checkout's own IdP (tsconfig `paths` falls back here): none.
import type { DemoEnv } from "@/lib/server/demo-session";

/** A development checkout's demo-sign-in grant for its own IdP. */
export interface DevSignin {
  /** The MUNIM_IDP value it serves; it also serves an unset MUNIM_IDP. */
  mode: string;
  /** The person's ID token, or null when the grant is refused or a setting is missing. Never throws. */
  grant(login: { email: string; password: string }, env: DemoEnv, fetchImpl: typeof fetch): Promise<string | null>;
}

export const devSignin: DevSignin | null = null;
