// "Latest wins" guard for overlapping async work, e.g. the transactions list's
// paged fetches. Each begin() starts a new operation and supersedes all prior
// tokens; an operation applies its result only while isCurrent(token) holds. So
// a response that resolves after a newer begin() — an out-of-order page-1 reload,
// or a loadMore still in flight when the filter changed — is discarded instead of
// corrupting the newer result set. Operations that ride the latest set (a
// loadMore appending to the current page-1) capture current() without bumping.
export function createLatestGuard() {
  let gen = 0;
  return {
    /** Start a new latest operation; supersedes every prior token. */
    begin: () => ++gen,
    /** The current token, without superseding — for work that rides the latest. */
    current: () => gen,
    /** Whether `token` is still the latest (nothing has superseded it). */
    isCurrent: (token: number) => token === gen,
  };
}

export type LatestGuard = ReturnType<typeof createLatestGuard>;
