import { resolve } from "node:path";
import type { NextConfig } from "next";

// Production calls Munim's API on this site's own origin: /api/* goes to MUNIM_API_ORIGIN (the munim-api deployment,
// or a local core-api). A plain Next rewrite, so it works on any host; unset (dev, tests) means no rewrite.
const apiOrigin = process.env.MUNIM_API_ORIGIN?.replace(/\/+$/, "");

// The container build (infra/gcp) sets MUNIM_NEXT_STANDALONE=1 for a self-contained server; unset, the build is unchanged.
// The tracing root is the workspace root, so the standalone output keeps the workspace packages.
const standalone = process.env.MUNIM_NEXT_STANDALONE === "1";

// No cacheComponents (and so no partialPrefetching): with it every route with a dynamic id (/o/[outletId], the tracker, the
// staff detail pages) is a PPR shell prerendered with placeholder params, and the deploy platform answers a client navigation's RSC request
// from that one cached prerender for every id (measured on munim-cobnut, 16 Oct: `x-matched-path: /o/[outletId].rsc`, HIT,
// segment keys `%%drp:…%%`), so useParams() sees no real id and the page says "This link isn't valid." until a reload.
// Without it those routes render per request (ƒ) and the static pages stay static. scripts/nav-smoke.ts is the gate.
const nextConfig: NextConfig = {
  ...(standalone ? { output: "standalone", outputFileTracingRoot: resolve(process.cwd(), "../..") } : {}),
  // @munim/sdk is a workspace package shipped as TypeScript source.
  transpilePackages: ["@munim/sdk"],
  rewrites: async () => (apiOrigin ? [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }] : []),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
