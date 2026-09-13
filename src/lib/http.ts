// Client-side JSON write helper. Throws on a non-2xx response so callers can
// surface the failure (e.g. an error toast) instead of silently showing success.
async function sendJson(method: string, url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json().catch(() => ({}));
}

// Client-side JSON read helper. Throws on a non-2xx response so a failed read
// becomes an error state instead of an error body parsed as data.
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export const postJson = (url: string, body: unknown) => sendJson("POST", url, body);
export const patchJson = (url: string, body: unknown) => sendJson("PATCH", url, body);
export const deleteJson = (url: string) => sendJson("DELETE", url, undefined);
