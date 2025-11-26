export default async function rateLimitSignup(req) {
  // 🚀 Disable rate limiting in development
  if (process.env.NODE_ENV !== "production") {
    return { ok: true };
  }

  // ⭐ Production logic stays as-is
  // your old rate limiter logic:
  // check IP/email count, Redis, DB, memory store etc.

  // Example:
  return { ok: true };
}
