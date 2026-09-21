import { execFile } from "node:child_process";
import { promisify } from "node:util";
import nodemailer from "nodemailer";

// How a digest leaves the Mac: the daily as an iMessage, the weekly as an email.
// Only the digest job imports this (never the web app). Two rules hold it
// together: message text and addresses reach AppleScript as ARGUMENTS, never
// spliced into the script (a vendor name is bank-supplied text); and nothing
// here logs or throws a secret — errors name the missing setting, not its value.

export type Message = { subject: string; text: string; html: string };
type Run = (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>;
type Mail = (smtp: { host: string; user: string; pass: string }, mail: { from: string; to: string } & Message) => Promise<unknown>;
export type DeliveryIo = { run: Run; mail: Mail };

// `account`/`participant` is the vocabulary since macOS 11 (checked by a real
// send on 26.5). Exit 0 means Messages took the text, not that it was
// delivered: a bad address shows only in the app, as "Not Delivered".
const IMESSAGE_SCRIPT = `on run argv
  set theTarget to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    set theAccount to first account whose service type = iMessage
    send theText to participant theTarget of theAccount
  end tell
end run`;
const NOTIFY_SCRIPT = `on run argv
  display notification (item 1 of argv) with title "Daybook"
end run`;
// An unanswered macOS permission prompt blocks the AppleEvent for about two
// minutes before it errors (-1712); don't let the job hang past that.
const OSA_TIMEOUT = 120_000;

const io: DeliveryIo = {
  run: promisify(execFile) as unknown as Run,
  mail: (smtp, mail) =>
    nodemailer
      .createTransport({ host: smtp.host, port: 465, secure: true, auth: { user: smtp.user, pass: smtp.pass } })
      .sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
};

type Env = Record<string, string | undefined>;
function need(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set in .env.local`);
  return v;
}

// The sender for a kind of digest, from the environment. Built before anything
// is sent, so a missing setting fails the run before the bank is even synced.
export function senderFor(kind: "daily" | "weekly", env: Env = process.env, using: DeliveryIo = io): (m: Message) => Promise<void> {
  if (kind === "daily") {
    const to = need(env, "DIGEST_IMESSAGE_TO");
    return async (m) => void (await using.run("/usr/bin/osascript", ["-e", IMESSAGE_SCRIPT, "--", to, m.text], { timeout: OSA_TIMEOUT }));
  }
  const to = need(env, "DIGEST_EMAIL_TO");
  const user = need(env, "SMTP_USER");
  // Google shows an app password in four groups; the spaces are not part of it.
  const pass = need(env, "SMTP_PASS").replace(/\s+/g, "");
  const host = env.SMTP_HOST?.trim() || "smtp.gmail.com";
  return async (m) => void (await using.mail({ host, user, pass }, { from: `Daybook <${user}>`, to, ...m }));
}

// A digest that could not be sent must not fail silently: a notification on the
// Mac (it needs no permission), best effort.
export async function notifyFailure(what: string, using: Pick<DeliveryIo, "run"> = io): Promise<void> {
  try {
    await using.run("/usr/bin/osascript", ["-e", NOTIFY_SCRIPT, "--", what], { timeout: 10_000 });
  } catch {
    // the log line is the record
  }
}
