// Dev server supervisor.
//
// Why this exists: Next's dev worker accumulates V8 heap over many HMR recompiles
// (Turbopack), and its built-in memory guard is REQUEST-GATED — it only checks
// `used_heap > 0.8 * heapLimit` in the request handler's finally block
// (next/dist/server/lib/start-server.js). So a compile spike between requests can
// blow past the V8 heap limit and the worker aborts with "Ineffective mark-compacts
// near heap limit" before the graceful restart ever fires. When that happens the
// whole `next dev` tree comes down (verified) and the user has to relaunch by hand.
// This relaunches it automatically so a long session never needs a manual restart.
//
// Subtlety: on a worker V8-OOM the worker dies by signal (SIGABRT) and the parent
// `next dev` then exits with code **0** (`child.exitCode || 0` is 0 on a
// signal-death). So we must NOT treat exit-code 0 as "clean" — the only reliable
// signal that the user actually asked to quit is our own SIGINT/SIGTERM handler
// setting `stopping`. Next handles its own graceful restarts internally (exit
// code 77, never surfaced here), so we never fight it.
//
// Paired with a right-sized --max-old-space-size (see package.json): a lower heap
// limit makes the 0.8x graceful-restart threshold fire earlier and far more often
// on this app's frequent polling, so the worker bounces gently long before the
// hard wall — making hard crashes rare, and self-healing when they do happen.

import { spawn } from "node:child_process";

// A session shorter than this counts as a "rapid" failure. A real OOM happens
// only after the server's been compiling for a while; repeated rapid exits mean a
// persistent error (syntax error, stuck port), so we give up instead of looping.
const RAPID_MS = 15000;
const MAX_RAPID = 4;

let child = null;
let stopping = false;
let rapidFails = 0;

function start() {
  const startedAt = Date.now();
  // `next` resolves via node_modules/.bin on the PATH npm sets for scripts.
  child = spawn("next", ["dev"], { stdio: "inherit", env: process.env });

  child.on("exit", (code, signal) => {
    child = null;
    // Defer briefly so a Ctrl-C that races with the child's own exit has time to
    // set `stopping` before we decide whether this was a requested stop.
    setTimeout(() => {
      if (stopping) process.exit(typeof code === "number" ? code : 0);

      // Unexpected exit (crash, or the OOM exit-0 described above) → relaunch,
      // with a circuit breaker so a persistent startup error doesn't hot-loop.
      if (Date.now() - startedAt >= RAPID_MS) {
        rapidFails = 0;
      } else if (++rapidFails >= MAX_RAPID) {
        console.error(
          `\n[dev] next dev exited ${rapidFails}× right after starting — not a transient ` +
            `OOM. Fix the error and re-run \`npm run dev\`.\n`
        );
        process.exit(1);
      }
      const delay = Math.min(500 * 2 ** rapidFails, 4000);
      console.warn(
        `\n[dev] next dev exited (code=${code}, signal=${signal ?? "—"}) — restarting in ${delay}ms…\n`
      );
      setTimeout(start, delay);
    }, 200);
  });

  child.on("error", (err) => {
    console.error("[dev] failed to launch next:", err);
    process.exit(1);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
    // Fallback if the child hangs; don't let the timer hold the loop open.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

start();
