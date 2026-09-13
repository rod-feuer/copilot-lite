import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Native form POST from the Sign out button: clear the session cookie and
// 303-redirect to the login screen. A RELATIVE Location, like the login route,
// so a phone resolves it against the host it actually used.
export async function POST() {
  const res = new NextResponse(null, { status: 303, headers: { Location: "/login" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
