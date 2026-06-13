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

// Only redirect to a same-origin path (no open redirect via ?from=//evil.com).
function safeFrom(v: string): string {
  return v.startsWith("/") && !v.startsWith("//") ? v : "/";
}

// 303 with a RELATIVE Location, so the browser resolves it against the host it
// actually used (e.g. http://<machine>.local from a phone). Building an absolute
// URL from req.url can yield localhost:3000 — unreachable from anything but this
// machine ("site can't be reached" on the phone).
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

// Native form POST (not JSON/fetch): the browser submits, we set the cookie and
// 303-redirect. The most reliable cross-browser/mobile flow — the cookie is
// committed as part of the navigation (no fetch→redirect race), and password
// managers can save it cleanly instead of re-prompting in a loop.
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  const from = safeFrom(String(form?.get("from") ?? "/"));

  // No password configured → nothing to log into; just proceed.
  if (!authEnabled()) return seeOther(from);

  const submitted = Buffer.from(password);
  const expected = Buffer.from(process.env.APP_PASSWORD ?? "");
  // Timing-safe (length check short-circuits, since timingSafeEqual needs equal
  // lengths, then a constant-time byte compare).
  const ok =
    submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
  if (!ok) {
    return seeOther(`/login?from=${encodeURIComponent(from)}&error=1`);
  }

  const res = seeOther(from);
  // `secure` only over real HTTPS, so the cookie still works over plain http on a
  // private network (e.g. Tailscale/LAN, where the transport is otherwise private).
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
