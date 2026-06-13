import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  authEnabled,
  createSessionToken,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // No password configured → nothing to log into; treat as success so the login
  // page (if reached directly) doesn't dead-end.
  if (!authEnabled()) return NextResponse.json({ ok: true });

  const body = await req.json().catch(() => ({}));
  const submitted = Buffer.from(String(body?.password ?? ""));
  const expected = Buffer.from(process.env.APP_PASSWORD ?? "");
  // Timing-safe: length check short-circuits (timingSafeEqual requires equal
  // lengths), then a constant-time compare of the bytes.
  const ok =
    submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
  if (!ok) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  // `secure` only when actually served over HTTPS, so the cookie still works over
  // plain http on a private Tailscale network (WireGuard already encrypts it).
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
    secure: proto === "https",
  });
  return res;
}
