import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundler and let
  // Node require it directly at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // Dev only: Next 16 blocks /_next/* dev resources for hosts it considers
  // cross-origin, which breaks client JS (no hydration, blank pages) when the app
  // is opened from a phone over the LAN by hostname/IP instead of localhost. Allow
  // the LAN names we use. (No effect on a production build.)
  allowedDevOrigins: ["rods-macbook-pro.local", "192.168.68.61"],
};

export default nextConfig;
