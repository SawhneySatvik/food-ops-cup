// The dev composition root: the only core-api file allowed to import adapters/dev (boundary rule
// adapters-dev-only-from-dev-root, R9). server.ts, core-worker's main.ts and the gates take their dev adapters
// from here.
export { devhostIdp } from "../../../adapters/dev/idp-devhost/index.ts";
export { createLocalIdp, type LocalIdp } from "../../../adapters/dev/idp-local/index.ts";
export { createHttpPublisher, type HttpPublisherOptions } from "../../../adapters/dev/publisher-http/src/index.ts";
