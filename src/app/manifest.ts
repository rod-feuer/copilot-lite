import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest; Next auto-links it). Makes
// the app installable and full-screen ("standalone") when added to the home
// screen. No service worker yet — that needs a secure context (HTTPS), which
// arrives with Tailscale; until then this still drives iOS "Add to Home Screen".
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Copilot Lite",
    short_name: "Copilot Lite",
    description: "A simplified personal finance dashboard",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#6d5efc",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
