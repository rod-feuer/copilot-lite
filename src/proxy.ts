import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, verifySessionToken } from "@/lib/auth";

// Next 16 renamed the `middleware` convention to `proxy`. Runs before routes
// render; here it's the single-user auth gate (see src/lib/auth.ts).

// Reachable without a session (the login screen and its endpoint).
const PUBLIC = ["/login", "/api/login"];

export async function proxy(req: NextRequest) {
  // Auth off (no APP_PASSWORD) → behave exactly as before.
  if (!authEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // Unauthenticated: API calls get a clean 401; page loads go to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Gate everything except Next internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webmanifest|txt)$).*)",
  ],
};
