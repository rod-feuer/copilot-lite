import { test } from "node:test";
import assert from "node:assert/strict";
import { senderFor, notifyFailure, type DeliveryIo } from "../src/lib/deliver";

const msg = { subject: "Daybook: On pace", text: "Daybook: On pace.", html: "<p>On pace.</p>" };
function fakeIo() {
  const ran: { file: string; args: string[]; timeout: number }[] = [];
  const mailed: { smtp: { host: string; user: string; pass: string }; mail: Record<string, string> }[] = [];
  const io: DeliveryIo = {
    run: async (file, args, opts) => void ran.push({ file, args, timeout: opts.timeout }),
    mail: async (smtp, mail) => void mailed.push({ smtp, mail }),
  };
  return { io, ran, mailed };
}

// WHY: a vendor's name is text a bank supplied, and it goes into the message.
// Spliced into AppleScript it would be code. It must reach osascript as an
// argument, after `--`, with the script itself a constant.
test("the daily goes out by iMessage with the text and address as arguments, never inside the script", async () => {
  const { io, ran } = fakeIo();
  const hostile = 'Daybook: $5 to Evil" & (do shell script "rm -rf ~") & " Llc';
  await senderFor("daily", { DIGEST_IMESSAGE_TO: "+15550100" }, io)({ ...msg, text: hostile });
  assert.equal(ran.length, 1);
  const { file, args, timeout } = ran[0];
  assert.equal(file, "/usr/bin/osascript");
  assert.deepEqual(args.slice(2), ["--", "+15550100", hostile], "address and text are the arguments after --");
  assert.equal(args[0], "-e");
  assert.ok(!args[1].includes("Evil") && !args[1].includes("+15550100"), "the script is a constant: nothing of the message is in it");
  assert.match(args[1], /send theText to participant theTarget/);
  assert.ok(timeout >= 60_000, "long enough for a macOS permission prompt to be answered, short enough not to hang the job");
});

// WHY: the weekly is an email through the owner's Gmail. Google shows an app
// password in four groups, and people paste it with the spaces.
test("the weekly goes out by email, from the configured account, with an app password pasted with its spaces", async () => {
  const { io, mailed, ran } = fakeIo();
  await senderFor("weekly", { DIGEST_EMAIL_TO: "me@example.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop" }, io)(msg);
  assert.equal(ran.length, 0);
  assert.deepEqual(mailed[0].smtp, { host: "smtp.gmail.com", user: "me@gmail.com", pass: "abcdefghijklmnop" });
  assert.deepEqual(mailed[0].mail, { from: "Daybook <me@gmail.com>", to: "me@example.com", ...msg });
});

// WHY: a missing setting should fail the run before the bank is synced or
// anything is built, and the error (which lands in a log file) must name the
// setting — never echo a value from the environment.
test("a missing setting fails at once, naming the setting and no value", () => {
  assert.throws(() => senderFor("daily", {}), /^Error: DIGEST_IMESSAGE_TO is not set in \.env\.local$/);
  const env = { DIGEST_EMAIL_TO: "me@example.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "   " };
  assert.throws(() => senderFor("weekly", env), (e: Error) => /SMTP_PASS is not set/.test(e.message) && !/me@/.test(e.message));
});

// WHY: a digest that can't be sent must not fail silently, and the alarm
// itself must never make things worse.
test("a failed send raises a notification on the Mac, and a failing notification is swallowed", async () => {
  const { io, ran } = fakeIo();
  await notifyFailure("The daily digest could not be sent.", io);
  assert.deepEqual(ran[0].args.slice(2), ["--", "The daily digest could not be sent."]);
  await notifyFailure("x", { run: async () => Promise.reject(new Error("no GUI session")) });
});
