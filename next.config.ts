import type { NextConfig } from "next";

// Hosts the dev server trusts for cross-origin HMR / _next asset requests when
// the app is reached over the LAN IP or a public hostname instead of localhost.
// Without this, Next.js 16 blocks those cross-origin dev requests and the page
// never hydrates. Sourced from FORGE_DEV_ORIGINS (.env.local) so no host is
// hardcoded here — it mirrors the value injected into each forge's own config.
// Only applies in dev mode; the production build ignores allowedDevOrigins.
const devOrigins = (process.env.FORGE_DEV_ORIGINS ?? "localhost")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
};

export default nextConfig;
