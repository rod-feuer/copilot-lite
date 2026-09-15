import type { KeyboardEvent } from "react";

// Keyboard-reachable list row. Rows hold nested controls (selects, buttons,
// inline editors), so they can't be a <button>; this gives a div/li button
// semantics instead: focusable, announced as a button, activated by Enter or
// Space. A keypress inside a nested control stays that control's — the row
// only activates when the row itself is the focused element. Click handling
// is unchanged; nested controls keep their own stopPropagation.
export function rowButtonProps(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // Space would otherwise scroll the page
        onActivate();
      }
      // Escape dismisses in steps: with the shelf open it closes the shelf
      // (the shelf's own listener) and the row keeps focus so a keyboard user
      // still knows where they are; pressed again on the bare row it drops
      // focus, and the focus ring with it. Browsers resume Tab from here.
      if (e.key === "Escape" && !document.querySelector("[data-shelf]")) e.currentTarget.blur();
    },
  };
}

// Visible focus for the row itself (mouse clicks don't show it).
export const ROW_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]";
