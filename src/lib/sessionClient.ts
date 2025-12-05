// src/lib/sessionClient.ts
// In-memory SID holder + helper fetch that applies Authorization header fallback.
// Do NOT persist to localStorage for security — memory only.

let _sid: string | null = null;

export function setSid(sid: string | null) {
  _sid = sid;
}

export function getSid(): string | null {
  return _sid;
}

/**
 * authFetch like fetch(), but:
 * - sets Authorization: Bearer <sid> if in-memory sid is present
 * - preserves credentials: include by default (so cookie will be sent when possible)
 */
export async function authFetch(input: RequestInfo, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (_sid) headers.set("Authorization", `Bearer ${_sid}`);
  // ensure credentials included so browser sends cookies when it can
  const opts: RequestInit = {
    credentials: "include",
    ...init,
    headers,
  };
  return fetch(input, opts);
}
