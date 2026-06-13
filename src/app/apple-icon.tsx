import { ImageResponse } from "next/og";

// iOS home-screen icon (Add to Home Screen). 180×180, full square — iOS applies
// its own rounded-squircle mask, so the source must NOT be pre-rounded. Centered
// "C" with padding for the mask's safe zone.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
          fontSize: 108,
          fontWeight: 700,
        }}
      >
        C
      </div>
    ),
    { ...size }
  );
}
