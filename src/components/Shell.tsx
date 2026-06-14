export default function Shell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      {/* Non-sticky on mobile so the header scrolls away and gives the small
          viewport back to content; sticky on desktop where there's room. */}
      {/* Title + subtitle form one block on the left; the actions sit on the
          right, vertically centered against the whole block (not pinned to the
          title line) so the header reads balanced. Keep subtitles short enough to
          sit beside the actions; if they don't fit, the actions wrap below. */}
      <header className="z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--background)] px-5 py-3 sm:sticky sm:top-0 sm:px-8 sm:py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-[var(--muted)]">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </header>
      <div className="px-5 pb-6 pt-4 sm:px-8 sm:py-6">{children}</div>
    </div>
  );
}
