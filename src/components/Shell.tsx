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
      <header className="sticky top-0 z-30 flex flex-col items-stretch justify-between gap-3 border-b border-[var(--border)] bg-[var(--background)] px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:px-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-[var(--muted)]">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-start gap-2">{actions}</div>
      </header>
      <div className="px-5 py-6 sm:px-8">{children}</div>
    </div>
  );
}
