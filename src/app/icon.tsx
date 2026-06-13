import { ImageResponse } from "next/og";

// App icon, generated (no binary asset) so it stays in sync with the brand. Full
// square, solid accent background, centered "C" with padding so it survives a
// maskable crop (Android) and iOS's squircle. Also the favicon (browsers
// downscale). Mirrors the sidebar/login logo.
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#6d5efc",
          color: "#ffffff",
          fontSize: 300,
          fontWeight: 700,
        }}
      >
        C
      </div>
    ),
    { ...size }
  );
}
