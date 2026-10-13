import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` otherwise writes a managed file into apps/web;
  // repo instructions live in the project rules only.
  agentRules: false,
  // Parallel `next dev` instances (one per lane, ports 3161–3165) each need their own dist dir: they share a lock
  // file otherwise. Lanes use NEXT_DIST_DIR=.next/lane-<port>: nested under .next, it stays inside every existing
  // exclude (git, dependency-cruiser, the boundaries red-proof's rsync). `make up` keeps the default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Next 16 blocks dev resources (HMR, dev chunks) for any host but "localhost" — without this a page opened on
  // 127.0.0.1 (Playwright, the lanes' URLs) never hydrates.
  allowedDevOrigins: ["127.0.0.1"],
  // No floating dev badge over the screens (screenshots are review evidence).
  devIndicators: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@munim/ui", "@munim/contracts", "@munim/sdk"],
};

export default nextConfig;
