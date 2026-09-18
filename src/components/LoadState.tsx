// Honest read states, shared by every page and the shelf. A read still in
// flight looks like loading, and a read that failed says so and offers a retry.
// Neither ever borrows the empty state, which would tell a user with a full
// database that they have no data.
export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-[var(--background)]" />
      ))}
    </div>
  );
}

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="card flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-[13px] text-[var(--muted)]">Couldn&rsquo;t load {what}.</p>
      <button type="button" onClick={onRetry} className="btn-ghost text-[13px]">
        Retry
      </button>
    </div>
  );
}
