// Native HTML form login — no client JS. The browser POSTs to /api/login, which
// sets the session cookie and 303-redirects. This is the most reliable flow on
// mobile (a fetch + window.location dance was looping there: the cookie wasn't
// committed before the follow-up navigation, and the password manager re-prompted
// instead of saving). Full-screen overlay covers the app chrome (sidebar) without
// a layout refactor — the proxy sends unauthenticated visitors here.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const from =
    sp.from && sp.from.startsWith("/") && !sp.from.startsWith("//") ? sp.from : "/";
  const failed = sp.error === "1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--background)] p-4">
      <form method="POST" action="/api/login" className="card w-full max-w-xs p-6">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">
            C
          </div>
          <div className="text-[15px] font-semibold tracking-tight">Copilot Lite</div>
        </div>
        <p className="mb-4 text-sm text-[var(--muted)]">Enter your password to continue.</p>
        <input type="hidden" name="from" value={from} />
        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          className="w-full rounded-lg border border-[var(--border)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
        />
        {failed && <p className="mt-2 text-xs text-rose-600">Incorrect password</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
