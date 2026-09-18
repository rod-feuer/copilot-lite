// The one category chip: a tinted circle carrying the category's icon.
// One rule for a missing icon — "" and "•" both mean none — and one fallback:
// the initial of `fallback` (the merchant's name) when given, else a neutral
// dot. One colour for "no category". Before this, eight surfaces drew the chip
// inline with three different fallbacks (↻, •, initial) and two radii.
export const NO_CATEGORY_COLOR = "#94a3b8";

export function categoryTint(color: string | null | undefined): string {
  return (color ?? NO_CATEGORY_COLOR) + "22"; // ~13% alpha of the category colour
}

export function categoryIconOrNull(icon: string | null | undefined): string | null {
  const t = icon?.trim();
  return t && t !== "•" ? t : null;
}

const SIZE = {
  xs: "h-5 w-5 text-[13px]", // dense rows: the glyph alone, no tint (see `plain`)
  sm: "h-9 w-9 text-[15px]", // list rows
  md: "h-10 w-10 text-lg", // statement / shelf headers
};

export function CategoryBadge({
  icon,
  color,
  size = "sm",
  fallback,
  plain = false,
  className = "",
}: {
  icon: string | null | undefined;
  color: string | null | undefined;
  size?: keyof typeof SIZE;
  fallback?: string | null; // a name whose initial stands in for a missing icon
  plain?: boolean; // no tinted circle — colour is for status, not identity
  className?: string;
}) {
  const glyph = categoryIconOrNull(icon);
  return (
    <span
      data-category-badge
      className={`flex shrink-0 items-center justify-center rounded-full ${SIZE[size]} ${className}`.trim()}
      style={plain ? undefined : { background: categoryTint(color) }}
    >
      {glyph ?? (
        <span className="text-[13px] font-semibold text-[var(--muted)]">
          {fallback?.trim() ? fallback.trim().slice(0, 1).toUpperCase() : "•"}
        </span>
      )}
    </span>
  );
}
