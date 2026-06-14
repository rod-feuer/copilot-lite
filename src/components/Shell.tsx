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
      <header className="z-30 flex flex-col gap-1 border-b border-[var(--border)] bg-[var(--background)] px-5 py-3 sm:sticky sm:top-0 sm:px-8 sm:py-4">
        {/* Title and actions share the top row (actions right-aligned). The
            subtitle sits on its own line below so it never widens the title
            column and pushes the actions down to a row of their own. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
        </div>
        {subtitle && <p className="text-sm text-[var(--muted)]">{subtitle}</p>}
      </header>
      <div className="px-5 pb-6 pt-4 sm:px-8 sm:py-6">{children}</div>
    </div>
  );
}
