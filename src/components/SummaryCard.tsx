import type { ReactNode } from "react";

// The page-top summary: one big figure on the left with a small-caps label,
// an optional counter-figure on the right, a thick progress bar, a status
// line, and a one-sentence note. Categories ("spent of budgeted / left") and
// Recurrings ("paid of expected / left to pay") share it, so the two tabs
// read as one app and neither can drift.
export function SummaryCard({
  primary,
  secondary,
  progress,
  alarm = false,
  status,
  note,
  className = "",
}: {
  primary: { value: string; label: string };
  secondary?: { value: string; label: string; alarm?: boolean };
  progress: number; // 0..1
  alarm?: boolean; // the bar turns red (over budget)
  status?: ReactNode; // the line under the bar; the caller sets its colours
  note?: ReactNode; // small helper sentence
  className?: string;
}) {
  const pct = Math.max(0, Math.min(progress, 1)) * 100;
  return (
    <div className={`card p-5 ${className}`.trim()} data-summary>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold tracking-tight">{primary.value}</div>
          <div className="stat-label">{primary.label}</div>
        </div>
        {secondary && (
          <div className="text-right">
            <div className={`text-2xl font-semibold tracking-tight ${secondary.alarm ? "text-rose-600" : ""}`}>
              {secondary.value}
            </div>
            <div className="stat-label">{secondary.label}</div>
          </div>
        )}
      </div>
      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--background)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: alarm ? "#e11d48" : "var(--accent)" }}
        />
      </div>
      {status && <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 text-xs">{status}</div>}
      {note && <p className="mt-2 text-[11px] text-[var(--muted)]">{note}</p>}
    </div>
  );
}
