// Run-token keys. Production PEMs come from config (packages/config); dev keys are generated once under
// `.run/keys/` (git-ignored, project rule 20) by running this file:
//   node services/core-api/src/runtoken/keys.ts
// It never overwrites an existing pair and never prints key material.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEV_KEY_DIR = resolve(import.meta.dirname, "../../../../.run/keys");
const PRIVATE_FILE = "run-token-ed25519.pem";
const PUBLIC_FILE = "run-token-ed25519.pub.pem";

export function loadRunTokenKeys(pem: { privateKeyPem: string; publicKeyPem: string }): { privateKey: KeyObject; publicKey: KeyObject } {
  const privateKey = createPrivateKey(pem.privateKeyPem);
  const publicKey = createPublicKey(pem.publicKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("run-token keys must be Ed25519");
  }
  return { privateKey, publicKey };
}

/** Returns the dev key pair in `dir`, generating it on first use. */
export function ensureDevRunTokenKeys(dir: string = DEV_KEY_DIR): { privateKeyPem: string; publicKeyPem: string; created: boolean } {
  const priv = join(dir, PRIVATE_FILE);
  const pub = join(dir, PUBLIC_FILE);
  if (existsSync(priv) && existsSync(pub)) {
    return { privateKeyPem: readFileSync(priv, "utf8"), publicKeyPem: readFileSync(pub, "utf8"), created: false };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(priv, privateKeyPem, { mode: 0o600 });
  writeFileSync(pub, publicKeyPem, { mode: 0o644 });
  return { privateKeyPem, publicKeyPem, created: true };
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const r = ensureDevRunTokenKeys();
  console.log(`run-token dev keys ${r.created ? "generated" : "already present"} in ${DEV_KEY_DIR}`);
}
