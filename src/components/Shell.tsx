"use client";

import { useLayoutEffect, useRef } from "react";

// The page anatomy (DESIGN.md §2, "The one page"): title with an optional
// one-line subtitle on the left; the month picker in ONE slot on every page,
// first in the right-hand cluster; page actions to its right. Search, filters
// and sort go in a <Toolbar>, which each page places between its summary
// card and the list the controls act on — never in the header, never above
// the summary (the summary is the month; the toolbar is the list).
export function Toolbar({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>{children}</div>;
}

export default function Shell({
  title,
  subtitle,
  month,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  month?: React.ReactNode; // the month picker, always in the same place
  actions?: React.ReactNode; // page actions (rare ones behind ⋯ on a phone)
  children: React.ReactNode;
}) {
  // The header is sticky on desktop, so anything else that sticks (a day
  // band in a statement list) must sit under it: publish its height as
  // --page-header on the page, measured, so it follows a wrapped subtitle.
  const wrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const h = head.current;
    const w = wrap.current;
    if (!h || !w) return;
    const set = () => {
      const sticky = getComputedStyle(h).position === "sticky";
      w.style.setProperty("--page-header", sticky ? `${h.offsetHeight}px` : "0px");
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(h);
    window.addEventListener("resize", set);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", set);
    };
  }, []);
  return (
    <div ref={wrap} className="mx-auto max-w-5xl">
      {/* Non-sticky on mobile so the header scrolls away and gives the small
          viewport back to content; sticky on desktop where there's room. */}
      {/* Title + subtitle form one block on the left; the actions sit on the
          right, vertically centered against the whole block (not pinned to the
          title line) so the header reads balanced. Keep subtitles short enough to
          sit beside the actions; if they don't fit, the actions wrap below. */}
      <header ref={head} className="z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--background)] px-4 py-3 sm:sticky sm:top-0 sm:px-8 sm:py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-xs text-[var(--muted)]">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {month}
          {actions}
        </div>
      </header>
      <div className="px-4 pb-6 pt-4 sm:px-8 sm:py-6">{children}</div>
    </div>
  );
}
