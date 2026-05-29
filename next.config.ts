import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server's client assets (HMR, /_next/*, fonts) to be requested
  // when the app is reached over the LAN IP instead of localhost. Without this,
  // Next.js 16 blocks those cross-origin dev requests and the page never hydrates.
  allowedDevOrigins: ['10.0.0.28', 'forge-pilot.crystalfountains.com'],
};

export default nextConfig;
