// scripts/reset-password.js (SSL-enabled, no updated_at)
// Usage: DATABASE_URL='postgres://...' node scripts/reset-password.js "<email>" "<newPassword>"

const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const [,, email, newPass] = process.argv;
if (!email || !newPass) {
  console.error('Usage: DATABASE_URL=... node scripts/reset-password.js "<email>" "<newPassword>"');
  process.exit(2);
}

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Please set DATABASE_URL env var (postgres://user:pass@host:port/db).');
    process.exit(3);
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const hash = await bcrypt.hash(newPass, 12);
    const res = await client.query(
      `UPDATE public.app_user
       SET password = $1
       WHERE lower(email) = lower($2)
       RETURNING id, email;`,
      [hash, email]
    );
    if (res.rowCount === 0) {
      console.error('No user updated — check the email address.');
      process.exit(4);
    }
    console.log('Success — rows updated:', res.rowCount, res.rows);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(5);
  } finally {
    try { await client.end(); } catch (e) {}
  }
})();
