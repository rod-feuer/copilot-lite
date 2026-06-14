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
      <header className="z-30 flex flex-col items-stretch justify-between gap-3 border-b border-[var(--border)] bg-[var(--background)] px-5 py-3 sm:sticky sm:top-0 sm:flex-row sm:flex-wrap sm:items-center sm:px-8 sm:py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-[var(--muted)]">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-start gap-2">{actions}</div>
      </header>
      <div className="px-5 pb-6 pt-4 sm:px-8 sm:py-6">{children}</div>
    </div>
  );
}
