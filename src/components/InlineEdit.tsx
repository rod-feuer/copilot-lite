"use client";
import { useState, type InputHTMLAttributes } from "react";
import { Tooltip } from "@/components/Tooltip";
import { useCommitInput } from "@/components/useCommitInput";

// Click-to-edit text: the value with a persistent faint ✎ cue at rest; an input
// while editing. Enter/blur commit, Escape reverts (useCommitInput). Used for
// every rename in the app — the shelf header, the categories row, the
// recurrings row — so the affordance and the keys are the same everywhere.
export function InlineEdit({
  value,
  onCommit,
  label = "Rename",
  className = "",
  textClassName = "text-sm font-medium",
  inputClassName = "",
}: {
  value: string;
  onCommit: (raw: string) => void;
  label?: string;
  className?: string; // the resting button
  textClassName?: string; // the resting text (also the input's type size)
  inputClassName?: string; // extra classes for the input (e.g. width)
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <Tooltip label={label} onlyIfTruncated={false} className={`group/n flex min-w-0 max-w-full ${className}`.trim()}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          className="flex min-w-0 max-w-full items-center gap-1 text-left"
        >
          <span className={`truncate ${textClassName}`}>{value}</span>
          {/* Persistent (faint) edit cue so the text reads as click-to-edit even
              without hovering; darkens on hover. */}
          <span className="shrink-0 text-[10px] text-[var(--muted)] transition-colors group-hover/n:text-[var(--foreground)]">
            <span className="inline-block -scale-x-100">✎</span>
          </span>
        </button>
      </Tooltip>
    );
  }
  return <EditingInput value={value} onCommit={onCommit} onDone={() => setEditing(false)} className={`${textClassName} ${inputClassName}`.trim()} />;
}

// The hook as a bare <input>, for fields whose "editing" state lives outside
// them (the transactions row's date and note editors, the budget input, the
// shelf's Expected field). Same keys, same revert, same flush.
export function CommitInput({
  defaultValue,
  onCommit,
  onDone,
  ...rest
}: {
  defaultValue: string;
  onCommit: (raw: string) => void;
  onDone?: () => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "defaultValue" | "onBlur" | "onKeyDown" | "onClick" | "ref" | "value">) {
  const { inputProps } = useCommitInput({ defaultValue, onCommit, onDone });
  return <input {...rest} {...inputProps} />;
}

// Mounted only while editing, so the hook's flush-on-unmount covers "the row
// re-rendered away mid-edit" and the input starts from the current value.
function EditingInput({ value, onCommit, onDone, className }: { value: string; onCommit: (raw: string) => void; onDone: () => void; className: string }) {
  const { inputProps } = useCommitInput({ defaultValue: value, onCommit, onDone });
  return (
    <input
      {...inputProps}
      autoFocus
      className={`min-w-0 flex-1 rounded-md border border-[var(--border)] bg-card px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 ${className}`}
    />
  );
}
