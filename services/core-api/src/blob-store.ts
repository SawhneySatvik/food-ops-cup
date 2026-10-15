// The blob store every composition root takes (T-116): one choice, by MUNIM_BLOB, so core-api (which writes uploads), the tick
// and core-worker (whose import parse reads them) always use the same store. "fs" (the default) is a directory on this machine:
// right for one machine (`make up`), wrong for a host that runs many instances, where an upload and its parse can land on
// different ones; "gcs" is a shared Cloud Storage bucket (MUNIM_BLOB_BUCKET), and any other accepted value is the dev mapping's
// shared store (packages/config `devAdapter`). Exported to the hosts as env-root's `blobStoreFromEnv`; the dev entries
// (server.ts, core-worker's main.ts) pass their `.run/blobs` directory for "fs".
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@munim/config";
import { gcsBlobStore } from "../../../adapters/gcp/blob-gcs/index.ts";
import { type BlobStore, localBlobStore } from "./modules/imports/index.ts";

export function blobStoreFromEnv(config: Config, fsDir = join(tmpdir(), "munim-blobs")): BlobStore {
  switch (config.blob) {
    case "fs":
      return localBlobStore(fsDir);
    case "gcs":
      return gcsBlobStore({ bucket: config.blobBucket() });
    default:
      return config.devAdapter("blob", config.blob) as BlobStore;
  }
}
