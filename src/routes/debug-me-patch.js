// server/src/routes/debug-me-patch.js
// Temporary debug handler for /api/me
// Purpose: log incoming SID cookie, attempt a safe DB lookup, and return safe JSON instead of crashing.
// IMPORTANT: Remove this file after you fix the root cause.

module.exports = function (app) {
  // try to locate DB client: prefer app.locals.db, fall back to common locations
  let db = app && app.locals && app.locals.db ? app.locals.db : null;
  if (!db) {
    try { db = require('../db'); } catch (e) { /* ignore */ }
  }
  if (!db) {
    try { db = require('../../db'); } catch (e) { /* ignore */ }
  }

  app.get('/api/me', async (req, res) => {
    try {
      const sid = (req.cookies && (req.cookies.sid || req.cookies.SESSION)) || null;
      console.debug('[DEBUG /api/me] incoming request', { sid, origin: req.headers.origin || null });

      // If no sid, return unauthenticated safely
      if (!sid) return res.status(200).json({ ok: true, user: null });

      // If no db available, log and return graceful response
      if (!db) {
        console.debug('[DEBUG /api/me] no db client available (app.locals.db or ../db). Returning safe unauthenticated response.');
        return res.status(200).json({ ok: true, user: null });
      }

      // Run tolerant lookup. Adjust query if your schema is different.
      const query = `
        SELECT s.sid, s.user_id, s.tenant_id as session_tenant_id, s.data as session_data,
               u.id as uid, u.email, u.name, u.is_active, u.company_id
        FROM sessions s
        LEFT JOIN app_user u ON u.id = s.user_id
        WHERE s.sid = $1
        LIMIT 1
      `;
      const params = [sid];

      let result;
      if (typeof db.query === 'function') {
        result = await db.query(query, params);
      } else if (typeof db.raw === 'function') {
        result = await db.raw(query, params);
      } else {
        console.debug('[DEBUG /api/me] unknown db client shape. Returning safe unauthenticated response.');
        return res.status(200).json({ ok: true, user: null });
      }

      // normalize rows for pg / knex results
      const rows = result && (result.rows || result[0] || result);
      const first = (Array.isArray(rows) && rows.length) ? rows[0] : (rows && rows.rows && rows.rows[0]) || null;

      console.debug('[DEBUG /api/me] db result sample:', { rowsCount: Array.isArray(rows) ? rows.length : (rows && rows.rows ? rows.rows.length : 'unknown'), first });

      if (!first) {
        return res.status(200).json({ ok: true, user: null });
      }

      const user = {
        id: first.user_id || first.uid || null,
        email: first.email || null,
        name: first.name || null,
        is_active: !!first.is_active,
        tenant_id: first.session_tenant_id || null,
        company_id: first.company_id || null,
      };

      console.debug('[DEBUG /api/me] resolved user:', user);
      return res.status(200).json({ ok: true, user });
    } catch (err) {
      console.error('[DEBUG /api/me] ERROR:', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'server_error', detail: String(err?.message || err) });
    }
  });
};
