"use client";

import { useRef, useState } from "react";
import { useToast } from "@/components/Toast";

export function MonthPicker({
  months,
  value,
  onChange,
  allowAll = false,
}: {
  months: string[];
  value: string;
  onChange: (m: string) => void;
  allowAll?: boolean;
}) {
  if (months.length === 0) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="btn-ghost cursor-pointer appearance-none pr-8"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%236b7280' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 12px center",
      }}
    >
      {allowAll && <option value="">All months</option>}
      {months.map((m) => (
        <option key={m} value={m}>
          {new Date(m + "-01T00:00:00Z").toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })}
        </option>
      ))}
    </select>
  );
}

export function ImportButton({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function handle(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const res = await fetch("/api/import", { method: "POST", body: text });
      const data = await res.json();
      if (!res.ok) {
        toast(`Import failed: ${data.error}`, "error");
      } else {
        toast(
          `Imported ${data.inserted} new · ${data.duplicates} duplicates skipped · ${data.errors} errored`,
          "success"
        );
        onDone();
      }
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])}
      />
      <button className="btn-ghost" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? "Importing…" : "Import CSV"}
      </button>
    </>
  );
}

export function SeedButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await fetch("/api/seed", { method: "POST" });
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn-primary" disabled={busy} onClick={run}>
      {busy ? "Loading…" : "Load sample data"}
    </button>
  );
}

export function SyncBankButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/plaid/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast(`Bank sync failed: ${data.error}`, "error");
      } else {
        toast(
          `Synced ${data.inserted} new · ${data.updated} updated`,
          "success"
        );
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn-ghost" disabled={busy} onClick={run}>
      {busy ? "Syncing…" : "Sync from bank"}
    </button>
  );
}
