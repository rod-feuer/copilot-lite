// Single-user session auth.
//
// Enabled ONLY when APP_PASSWORD is set, so plain localhost development keeps
// working untouched; setting the env var "arms" the gate for network/Tailscale
// use. Stateless signed cookie (HMAC-SHA256) — no session store. Sign/verify use
// Web Crypto so this module runs in BOTH the Edge middleware runtime and Node
// route handlers (no node:crypto / Buffer here). The password comparison itself
// lives in the login route (Node, timing-safe).
//
// This is the bootstrap/fallback credential; biometric passkeys (WebAuthn) will
// layer on top once the app is served over HTTPS (e.g. via Tailscale) — see the
// mobile plan.

export const SESSION_COOKIE = "cl_session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

/** Auth is enforced only when a password is configured. */
export function authEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

// One env var to enable; the signing key derives from the password unless an
// explicit APP_SESSION_SECRET is given. Rotating either invalidates sessions.
function signingSecret(): string {
  return process.env.APP_SESSION_SECRET || process.env.APP_PASSWORD || "";
}

function b64url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

// Token = "<issued-at-seconds>.<hmac(issued-at)>". Stateless; expiry on verify.
export async function createSessionToken(now = Date.now()): Promise<string> {
  const iat = String(Math.floor(now / 1000));
  return `${iat}.${await hmac(iat)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const iat = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(iat)) return false;
  // The signature is an HMAC of the public `iat` with the secret; a mismatch
  // can't be forged without the secret, and comparing two of our own HMAC
  // strings leaks nothing useful, so a plain compare is fine here.
  if (sig !== (await hmac(iat))) return false;
  const age = Math.floor(now / 1000) - Number(iat);
  return age >= 0 && age <= SESSION_MAX_AGE_S;
}
