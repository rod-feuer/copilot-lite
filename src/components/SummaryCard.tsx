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
  // Every figure is left-aligned: the three read as one row of columns. Pinned
  // to the card's edges, Net and the pair had 600px of nothing between them on
  // a wide screen. `align` is kept for callers; it no longer moves text.
  const cls = align === "right" || align === "pair" ? "" : "";
  return f.href ? (
    <Link href={f.href} className={`${cls} block rounded-lg hover:underline`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
export function SummaryCard({
  eyebrow,
  barTitle,
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
  eyebrow?: string; // the card's frame, said once ("September, projected") so the labels needn't
  primary: Figure;
  secondary?: Figure | Figure[];
  progress: number; // 0..1
  barLabel: string; // what the bar measures, for assistive tech ("70% of expected bills paid")
  barCaption?: ReactNode; // the same, in sight — where the figures above don't already say it
  barTitle?: string; // the budget panel's label ("Budget", "Bills")
  alarm?: boolean; // the bar turns red (over budget)
  status?: ReactNode; // the line under the bar; the caller sets its colours
  note?: ReactNode; // small helper sentence
  className?: string;
}) {
  const pct = Math.max(0, Math.min(progress, 1)) * 100;
  return (
    <div className={`card p-6 ${className}`.trim()} data-summary>
      {eyebrow && (
        <div data-eyebrow className="stat-label mb-4">
          {eyebrow}
        </div>
      )}
      {/* Two panels: the month's figures on the left, the budget on the right,
          level with them. One column in a full-width card left the right two
          thirds empty above a bar that ran the whole width. A hairline
          separates the panels; on a phone and a tablet they stack. */}
      {/* The same 3:2 grid and 24px gap as the page's cards below, run to the
          card's edges (the negative margin undoes the padding), so the figures
          span the chart card's width and the budget panel the category card's.
          The hairline stands in the middle of the gutter between them. */}
      <div className="grid grid-cols-1 gap-6 lg:-mx-6 lg:grid-cols-5">
        {/* Figures share a top line. On desktop they are three equal columns
            across the chart card's width below; on a tablet, columns at least
            128px wide (a long label such as Recurrings' "paid so far of
            $19,688 expected" may widen its column to 192px rather than wrap
            into three lines). */}
        <div className="relative flex flex-wrap items-start gap-x-8 gap-y-4 lg:col-span-3 lg:grid lg:grid-cols-3 lg:gap-x-6 lg:pl-6 lg:after:absolute lg:after:-right-3 lg:after:top-0 lg:after:bottom-0 lg:after:border-l lg:after:border-[var(--border)] lg:after:content-['']">
          <div className="min-w-0 max-sm:flex-1 sm:min-w-32 sm:max-w-48 lg:max-w-none">
            <Fig f={primary} />
          </div>
          {/* Two counter-figures don't fit beside the primary on a phone: they
              wrapped one under the other, right-aligned, a staircase. There they
              sit as a pair of columns on the primary's left edge instead. */}
          {Array.isArray(secondary) && secondary.length > 1 ? (
            <div data-figure-pair className="grid w-full grid-cols-2 items-start gap-4 sm:flex sm:w-auto sm:flex-wrap sm:gap-8 lg:contents">
              {secondary.map((f, i) => (
                <div key={i} className="min-w-0 sm:min-w-32 sm:max-w-48 lg:max-w-none">
                  <Fig f={f} align="pair" />
                </div>
              ))}
            </div>
          ) : (
            secondary && (
              <div className="flex flex-wrap items-start gap-8 lg:contents">
                {(Array.isArray(secondary) ? secondary : [secondary]).map((f, i) => (
                  <div key={i} className="min-w-0 sm:min-w-32 sm:max-w-48 lg:max-w-none">
                    <Fig f={f} align="right" />
                  </div>
                ))}
              </div>
            )
          )}
        </div>
        {/* The panel's label sits on the figures' top line and its bar on their
            label line, so the two panels read as one row. */}
        <div data-budget-panel className="min-w-0 lg:col-span-2 lg:pl-4 lg:pr-6 lg:pt-1">
          {(barTitle || barCaption) && (
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <div className="stat-label">{barTitle}</div>
              {barCaption && (
                <div data-bar-caption className="whitespace-nowrap text-xs text-[var(--muted)]">
                  {barCaption}
                </div>
              )}
            </div>
          )}
          <div
            className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--background)]"
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
          {/* The verdict describes the bar — "on pace to finish under
              budget", "2 overdue · 20 upcoming · 60 paid", "Lake Home over
              budget" — so it sits under it, the panel's conclusion. Above the
              figures it claimed a headline role it didn't have, and on
              Recurrings read as a stray line of counts over the money. */}
          {status && <div data-status className="mt-3 flex flex-wrap items-center gap-x-2 text-[15px] font-semibold">{status}</div>}
          {note && <p className="mt-2 text-[11px] text-[var(--muted)]">{note}</p>}
        </div>
      </div>
    </div>
  );
}
