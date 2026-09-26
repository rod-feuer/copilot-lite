"use client";

import { useCallback, useState } from "react";
import { defaultMonth } from "@/lib/format";
import { getJson } from "@/lib/http";

// The month picker on Dashboard, Categories, and Recurrings boots the same way:
// read the months that have data, land on the latest, then load that month.
// A retry keeps a month the user already picked. Transactions is the exception —
// its month comes from the URL.
export function useMonthBoot() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const boot = useCallback(async (load: (month: string) => Promise<void>) => {
    setStatus("loading");
    try {
      const ms = await getJson<string[]>("/api/months");
      setMonths(ms);
      const def = defaultMonth(ms);
      let chosen = def;
      setMonth((cur) => {
        chosen = cur || def;
        return chosen;
      });
      await load(chosen);
    } catch {
      setStatus("error");
    }
  }, []);

  return { months, setMonths, month, setMonth, status, setStatus, boot };
}
