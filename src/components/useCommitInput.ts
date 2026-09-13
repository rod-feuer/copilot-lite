"use client";
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type FocusEvent } from "react";

// The one behaviour of an inline editor's <input>, shared by every click-to-edit
// and edit-in-place field: Enter commits (by blurring), Escape reverts without
// committing, blur commits, clicks and keys stop at the input so the row's own
// handlers don't fire, and an uncommitted edit is flushed if the input unmounts
// mid-edit. Six copies of this existed and disagreed — one ignored Escape.
//
// Uncontrolled: the caller passes `defaultValue` and gets the raw string in
// `onCommit`; what "commit" means (trim, clear-when-equal, parse a number) is
// the caller's. `onDone` runs after a commit or a revert, for callers that hold
// an "editing" state.
export function useCommitInput({
  defaultValue,
  onCommit,
  onDone,
}: {
  defaultValue: string;
  onCommit: (raw: string) => void;
  onDone?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const reverted = useRef(false);
  const committed = useRef(defaultValue); // last value already sent on
  // Latest callbacks, read from the unmount flush (same pattern as useSyncedRefresh).
  const latest = useRef({ onCommit, onDone });
  useEffect(() => {
    latest.current = { onCommit, onDone };
  });
  const commit = (raw: string) => {
    committed.current = raw;
    latest.current.onCommit(raw);
  };
  // Flush on unmount: hold the node from mount time (the ref may be detached by
  // the time cleanup runs) and commit if the live value is an uncommitted edit.
  useEffect(() => {
    const el = inputRef.current;
    return () => {
      if (!reverted.current && el && el.value !== committed.current) latest.current.onCommit(el.value);
    };
  }, []);
  return {
    inputRef,
    inputProps: {
      ref: inputRef,
      defaultValue,
      onClick: (e: MouseEvent<HTMLInputElement>) => e.stopPropagation(),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          reverted.current = true;
          e.currentTarget.value = defaultValue;
          e.currentTarget.blur();
        }
      },
      onBlur: (e: FocusEvent<HTMLInputElement>) => {
        if (reverted.current) {
          reverted.current = false;
          latest.current.onDone?.();
          return;
        }
        commit(e.target.value);
        latest.current.onDone?.();
      },
    },
  };
}
