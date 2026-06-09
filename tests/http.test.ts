import { test } from "node:test";
import assert from "node:assert/strict";
import { postJson } from "../src/lib/http";

function stubFetch(res: { ok: boolean; status: number; body?: unknown }) {
  globalThis.fetch = (async () => ({
    ok: res.ok,
    status: res.status,
    json: async () => res.body ?? {},
  })) as unknown as typeof fetch;
}

test("postJson returns the parsed body on a 2xx response", async () => {
  stubFetch({ ok: true, status: 200, body: { ok: 1 } });
  assert.deepEqual(await postJson("/x", { a: 1 }), { ok: 1 });
});

test("postJson throws on a non-2xx response (so callers can surface it)", async () => {
  stubFetch({ ok: false, status: 500 });
  await assert.rejects(() => postJson("/x", {}), /500/);
});
