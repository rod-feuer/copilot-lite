// The two scheduled jobs, as macOS LaunchAgents. Pure text here, so it can be
// tested; scripts/digest-install.ts writes the files and loads them.
//
// A LaunchAgent (not a daemon): it runs in the logged-in user's session, which
// the Messages app needs. A run missed while the Mac slept fires on wake; a Mac
// that is off or logged out does not catch up. Both times are before 19:00
// local on purpose: the app's "today" is a UTC date, and a later run in a
// western timezone would already be on tomorrow's.
export const SCHEDULE = {
  daily: { label: "com.daybook.digest-daily", when: { Hour: 7, Minute: 30 } },
  weekly: { label: "com.daybook.digest-weekly", when: { Weekday: 0, Hour: 18, Minute: 0 } }, // Sunday
} as const;
export type Kind = keyof typeof SCHEDULE;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (t: string) => `<string>${esc(t)}</string>`;

// `node` is pinned to an absolute path: launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin,
// and the native SQLite module is built for that Node. `path` adds where the
// bank CLI lives. The plist carries NO secrets — it is world-readable; the job
// reads .env.local itself, from `repo`, which is also what makes the
// cwd-relative database path resolve.
export function launchAgentPlist(kind: Kind, o: { node: string; repo: string; path: string }): string {
  const { label, when } = SCHEDULE[kind];
  const args = [o.node, "--env-file-if-exists=.env.local", "--import", "tsx", "scripts/digest.ts", kind];
  const log = `${o.repo}/data/digest.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label)}
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    ${str(a)}`).join("\n")}
  </array>
  <key>WorkingDirectory</key>${str(o.repo)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${str(o.path)}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
${Object.entries(when).map(([k, v]) => `    <key>${k}</key><integer>${v}</integer>`).join("\n")}
  </dict>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}
