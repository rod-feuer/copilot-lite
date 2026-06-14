"use client";

// A search input with a clear (✕) affordance — shown only when there's text,
// and Escape also clears. onChange receives the new value (so a custom handler,
// e.g. the Transactions auto-widen, runs on clear too).
export function SearchBox({
  value,
  onChange,
  placeholder,
  className = "w-60",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    // Width lives on the wrapper (so `w-full sm:w-60` actually sizes the box); the
    // input fills it. Default keeps the old fixed width for any caller.
    <div className={`relative ${className}`}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
        placeholder={placeholder}
        className="btn-ghost w-full pl-4 pr-7 font-normal placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          ✕
        </button>
      )}
    </div>
  );
}
