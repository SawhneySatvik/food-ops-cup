import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` otherwise writes a managed file into apps/web;
  // repo instructions live in the project rules only.
  agentRules: false,
};

export default nextConfig;
