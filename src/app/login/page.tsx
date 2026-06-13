"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Full-screen overlay (z-50) so it covers the app chrome (sidebar) without a
// layout refactor — middleware sends unauthenticated visitors here.
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError("Incorrect password");
        setBusy(false);
        return;
      }
      const from = new URLSearchParams(window.location.search).get("from") || "/";
      router.replace(from);
      router.refresh(); // re-run server components now that we're authed
    } catch {
      setError("Something went wrong — please try again");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--background)] p-4">
      <form onSubmit={submit} className="card w-full max-w-xs p-6">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">
            C
          </div>
          <div className="text-[15px] font-semibold tracking-tight">Copilot Lite</div>
        </div>
        <p className="mb-4 text-sm text-[var(--muted)]">Enter your password to continue.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-[var(--border)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
        />
        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-4 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
