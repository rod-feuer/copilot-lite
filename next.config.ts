import os from "node:os";
import type { NextConfig } from "next";

// Every name this machine answers to on the local network, read when the dev
// server starts: its current IPv4 addresses, and any Bonjour (.local) name. The list used
// to be written by hand, with one address in it — and the router handed out a
// different one (192.168.68.61 became 192.168.20.154), so the phone got the
// page shell and no data: Next blocked the scripts and nothing said why. If the
// address changes while the server is running, restart it.
const lanOrigins = [
  ...Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address),
  "*.local", // the Bonjour name (Rods-MacBook-Pro.local); os.hostname() can be the router's name for us instead
];

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the bundler and let
  // Node require it directly at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // Dev only: Next 16 blocks /_next/* dev resources for hosts it considers
  // cross-origin, which breaks client JS (no hydration, blank pages) when the app
  // is opened from a phone over the LAN by hostname/IP instead of localhost. Allow
  // this machine's own LAN names. (No effect on a production build.)
  allowedDevOrigins: lanOrigins,
};

export default nextConfig;
