"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/components/Sidebar";

// Mobile navigation: a fixed bottom tab bar (the desktop sidebar is hidden below
// `sm`). Reuses the sidebar's NAV items/icons so the two never drift. Hidden at
// `sm`+. The layout pads `main` so content clears this bar.
export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--border)] bg-card pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      {NAV.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
              active ? "text-[var(--accent)]" : "text-[var(--muted)]"
            }`}
          >
            <n.Icon />
            <span>{n.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
