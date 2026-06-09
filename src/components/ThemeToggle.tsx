"use client";

import { useEffect, useState } from "react";

// Toggles light/dark by setting data-theme on <html> and persisting to
// localStorage. The initial theme is applied pre-paint by an inline script in
// the layout (no flash); this just keeps the button label in sync and flips it.
export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    // Sync the label to the theme applied pre-paint by the layout script.
    // (Reading during render would cause an SSR/client hydration mismatch.)
    const current =
      (document.documentElement.dataset.theme as "light" | "dark") || "light";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setTheme(next);
  }

  return (
    <button onClick={toggle} className="nav-link w-full" aria-label="Toggle theme">
      <span className="text-base">{theme === "dark" ? "☀️" : "🌙"}</span>
      <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}
