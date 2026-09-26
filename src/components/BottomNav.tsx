"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/components/Sidebar";
import SignOut from "@/components/SignOut";
import ThemeToggle from "@/components/ThemeToggle";

// Mobile navigation: a fixed bottom tab bar (the desktop sidebar is hidden below
// `sm`). Reuses the sidebar's NAV items/icons so the two never drift. Hidden at
// `sm`+. The layout pads `main` so content clears this bar.
// `signOut`: the layout passes whether the password gate is on; the tab bar is
// the one always-visible chrome on a phone, so that is where Sign out lives.
export default function BottomNav({ signOut = false }: { signOut?: boolean }) {
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
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors ${
              active ? "text-[var(--accent)]" : "text-[var(--muted)]"
            }`}
          >
            <n.Icon />
            <span>{n.label}</span>
          </Link>
        );
      })}
      {signOut && <SignOut variant="tab" />}
      {/* The sidebar's theme switch is desktop-only. The tab bar is the chrome
          that stays on screen while the header scrolls away. */}
      <div className="flex items-center pr-1">
        <ThemeToggle compact />
      </div>
    </nav>
  );
}
