// Which origins and host names may use this app's credentials (DNS rebinding, CSRF). An explicit allow-list, never a
// comparison with the request's own Host header: under DNS rebinding the attacker controls Origin AND Host
// (http://evil.example:3160 resolving to 127.0.0.1).
//   production: exactly the origins in MUNIM_WEB_ORIGINS — comma-separated scheme://host[:port], e.g.
//               "https://app.example.com,https://demo.example.com:8443" (a deploy setting, set on the web service).
//               Host is not consulted: front ends (Firebase Hosting, Cloud Run, load balancers) rewrite it.
//   dev:        localhost, 127.0.0.1 and [::1] on any port (plus any configured origin).
import { headers } from "next/headers";

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const production = () => process.env.NODE_ENV === "production";

function configured(): Set<string> {
  return new Set((process.env.MUNIM_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    try {
      return new URL(s).origin;
    } catch {
      return "";
    }
  }).filter(Boolean));
}

/** An Origin header value the app accepts a credentialed write from. "null" (sandboxed frames) and junk are refused. */
export function originAllowed(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (configured().has(u.origin)) return true;
  return !production() && LOCAL_NAMES.has(u.hostname);
}

/** A Host header the app serves credentialed requests on. Dev only: in production every request passes (Host is the
 *  front end's to rewrite) and the Origin allow-list carries the write check; dev sign-in does not exist there. */
export function hostAllowed(host: string | null): boolean {
  if (production()) return true;
  if (!host) return false;
  try {
    return LOCAL_NAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** hostAllowed for the current request (server components and actions). */
export async function requestHostAllowed(): Promise<boolean> {
  return hostAllowed((await headers()).get("host"));
}
