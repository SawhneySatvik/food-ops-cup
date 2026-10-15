// The IdP every composition root takes (T-122): one choice, by MUNIM_IDP (resolveIdpMode). "identity-platform" verifies
// Identity Platform ID tokens (adapters/gcp); "local" is the dev-only signer whose key lives under the run dir; any other
// accepted value is the dev mapping's (packages/config `devAdapter`), absent from a build without the dev adapters.
import type { Config, IdpMode } from "@munim/config";
import { identityPlatformIdp } from "../../../adapters/gcp/idp-identity-platform/index.ts";
import { createPersistentLocalIdp } from "./auth/local-idp.ts";
import type { IdP } from "./auth/port.ts";

export function idpFromConfig(config: Config, mode: IdpMode): IdP {
  switch (mode) {
    case "identity-platform":
      return identityPlatformIdp({ projectId: config.idpProjectId() });
    case "local":
      return createPersistentLocalIdp(config.runDir);
    default:
      return config.devAdapter("idp", mode) as IdP;
  }
}
