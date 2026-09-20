import type { ReactNode } from "react";
import Link from "next/link";

// The page-top summary: one big figure on the left with a small-caps label,
// one or more counter-figures on the right, a thick progress bar, a status
// line, and a one-sentence note. Categories ("spent of budgeted / left"),
// Recurrings ("paid of expected / left to pay") and the Dashboard ("net,
// projected / income / expenses") share it, so the tabs read as one app and
// none can drift.
export type Figure = {
  value: string;
  label: ReactNode;
  sub?: ReactNode; // a quiet line under the label, in normal case (a delta, "so far")
  href?: string; // the figure drills into the list behind it
  tone?: "good" | "bad";
  alarm?: boolean; // = tone "bad"
};
function Fig({ f, align = "left" }: { f: Figure; align?: "left" | "right" | "pair" }) {
  const colour =
    f.alarm || f.tone === "bad" ? "text-[var(--bad)]" : f.tone === "good" ? "text-[var(--good)]" : "";
  const inner = (
    <>
      <div className={`text-2xl font-semibold tracking-tight ${colour}`}>{f.value}</div>
      <div className="stat-label">{f.label}</div>
      {f.sub && <div className="text-xs text-[var(--muted)]">{f.sub}</div>}
    </>
  );
  const cls = align === "right" ? "text-right" : align === "pair" ? "sm:text-right" : "";
  return f.href ? (
    <Link href={f.href} className={`${cls} block rounded-lg hover:underline`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
export function SummaryCard({
  primary,
  secondary,
  progress,
  barLabel,
  barCaption,
  alarm = false,
  status,
  note,
  className = "",
}: {
  primary: Figure;
  secondary?: Figure | Figure[];
  progress: number; // 0..1
  barLabel: string; // what the bar measures, for assistive tech ("70% of expected bills paid")
  barCaption?: ReactNode; // the same, in sight — where the figures above don't already say it
  alarm?: boolean; // the bar turns red (over budget)
  status?: ReactNode; // the line under the bar; the caller sets its colours
  note?: ReactNode; // small helper sentence
  className?: string;
}) {
  const pct = Math.max(0, Math.min(progress, 1)) * 100;
  return (
    <div className={`card p-6 ${className}`.trim()} data-summary>
      {/* Figures share a top line. Bottom-aligned, a taller caption under one
          figure pushed its number up, and the three big numbers sat on three
          different lines. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Fig f={primary} />
        {/* Two counter-figures don't fit beside the primary on a phone: they
            wrapped one under the other, right-aligned, a staircase. There they
            sit as a pair of columns on the primary's left edge instead. */}
        {Array.isArray(secondary) && secondary.length > 1 ? (
          <div data-figure-pair className="grid w-full grid-cols-2 items-start gap-4 sm:flex sm:w-auto sm:flex-wrap sm:justify-end sm:gap-6">
            {secondary.map((f, i) => (
              <Fig key={i} f={f} align="pair" />
            ))}
          </div>
        ) : (
          secondary && (
            <div className="flex flex-wrap items-start justify-end gap-6">
              {(Array.isArray(secondary) ? secondary : [secondary]).map((f, i) => (
                <Fig key={i} f={f} align="right" />
              ))}
            </div>
          )
        )}
      </div>
      {barCaption && (
        <div data-bar-caption className="mt-4 text-xs text-[var(--muted)]">
          {barCaption}
        </div>
      )}
      <div
        className={`${barCaption ? "mt-1" : "mt-3"} h-2.5 overflow-hidden rounded-full bg-[var(--background)]`}
        role="progressbar"
        aria-label={barLabel}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: alarm ? "#e11d48" : "var(--accent)" }}
        />
      </div>
      {status && <div className="mt-3 flex flex-wrap items-center gap-x-2 text-xs">{status}</div>}
      {note && <p className="mt-2 text-[11px] text-[var(--muted)]">{note}</p>}
    </div>
  );
}
