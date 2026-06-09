"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";

const NAV = [
  { href: "/", label: "Dashboard", icon: "◧" },
  { href: "/transactions", label: "Transactions", icon: "⇅" },
  { href: "/categories", label: "Categories", icon: "◑" },
  { href: "/recurrings", label: "Recurrings", icon: "↻" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-card px-3 py-5 sm:flex">
      <div className="mb-6 flex items-center gap-2 px-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-white">
          C
        </div>
        <div className="text-[15px] font-semibold tracking-tight">Copilot Lite</div>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`nav-link ${active ? "nav-link-active" : ""}`}
            >
              <span className="w-4 text-center text-base leading-none">{n.icon}</span>
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 pt-4">
        <ThemeToggle />
        <div className="px-3 pt-1 text-[11px] leading-relaxed text-[var(--muted)]">
          Local prototype · data stays on your Mac
        </div>
      </div>
    </aside>
  );
}
