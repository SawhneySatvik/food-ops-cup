import type { NextConfig } from "next";

// Production calls Munim's API on this site's own origin: /api/* goes to MUNIM_API_ORIGIN (the munim-api deployment,
// or a local core-api). A plain Next rewrite, so it works on any host; unset (dev, tests) means no rewrite.
const apiOrigin = process.env.MUNIM_API_ORIGIN?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
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
