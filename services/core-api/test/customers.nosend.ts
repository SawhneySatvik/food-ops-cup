// Scanner for the "no code path sends a message" gate (R40 C6): no outbound network, mail/SMS client, delivery
// adapter import, or 'sent' campaign status may appear in the customers module. Used by customers.test.ts, which
// proves it fires on planted send paths before trusting its silence on the real module.
// R67 (T-128): the sent status may appear in exactly one file, campaign-sent.ts (a demo business's simulated record of a
// queued campaign, the owner's own command). That file is still scanned for every other pattern.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const PATTERNS: Array<[string, RegExp]> = [
  ["fetch call", /\bfetch\s*\(/],
  ["http(s)/net/tls/dgram client", /from\s+["'](?:node:)?(?:https?|net|tls|dgram|http2)["']|\brequire\(\s*["'](?:node:)?(?:https?|net|tls|dgram)["']/],
  ["net.connect / socket", /\b(?:net|tls)\.(?:connect|createConnection)\s*\(|\bnew\s+(?:WebSocket|XMLHttpRequest)\b/],
  ["mail/SMS client", /\b(?:nodemailer|sendgrid|mailgun|postmark|twilio|[a-z0-9]+-sdk|ses|sns|smtp|msg91|gupshup|whatsapp)\b/i],
  ["send function", /\bsend(?:Email|Mail|Sms|Text|Message|Campaign|Whatsapp)\b/i],
  ["delivery adapter import", /from\s+["'][^"']*adapters\/[^"']*["']|publisher-http/],
  ["campaign 'sent' status", /["'`]sent["'`]/],
];
const SENT_PATTERN = "campaign 'sent' status";
/** The one file that records a queued campaign as sent (simulated) on a demo business (R67). */
export const SENT_ALLOWED_IN = "campaign-sent.ts";

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mts|js)$/.test(n)) yield p;
  }
}

/** Every hit in the directory's source (plus `extra` planted files, for the red-proof), as "file: pattern". */
export function findSendPaths(dir: string, o: { extra?: Record<string, string> } = {}): string[] {
  const files: Array<[string, string]> = [...walk(dir)].map((p) => [p, readFileSync(p, "utf8")]);
  files.push(...Object.entries(o.extra ?? {}));
  const hits: string[] = [];
  for (const [file, text] of files) {
    // Comments describe the absence of a send path; only code counts.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const [name, re] of PATTERNS) {
      if (name === SENT_PATTERN && basename(file) === SENT_ALLOWED_IN) continue;
      if (re.test(code)) hits.push(`${file}: ${name}`);
    }
  }
  return hits;
}
