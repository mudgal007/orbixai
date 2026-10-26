import type { NextConfig } from "next";

const api = process.env.ORBIX_API_INTERNAL_URL ?? "http://localhost:4000";

const config: NextConfig = {
  // Same-origin API: the browser calls /api/v1/*, so the session cookie stays first-party.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${api}/v1/:path*` }];
  },
  // Standalone output (used by the Docker image) needs symlinks, which Windows blocks without Developer Mode.
  output: process.env.NEXT_STANDALONE === "true" ? "standalone" : undefined,
  compress: false, // keeps Server-Sent Events unbuffered through the rewrite
  poweredByHeader: false,
};

export default config;
