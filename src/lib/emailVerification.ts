// server/src/lib/emailVerification.ts
import crypto from "crypto";
import { pool } from "../db";

export type VerificationTokenRecord = {
  user_id: string;
  email: string;
  token: string;
  expires_at: Date;
};

/**
 * Create verification token for a user.
 */
export async function createVerificationToken(
  userId: string,
  email: string
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await pool.query(
    `
    INSERT INTO email_verification_tokens (user_id, email, token, expires_at)
    VALUES ($1, $2, $3, $4)
    `,
    [userId, email, token, expiresAt]
  );

  return token;
}

/**
 * Send email verification email.
 * Replace console.log with your SendGrid / SES / Mailgun integration later.
 */
export async function sendVerificationEmail(email: string, token: string) {
  const verifyUrl = `${process.env.APP_BASE_URL || "https://app.zyntra.com"}/verify-email?token=${token}`;

  // TODO: Replace with real email service later
  console.log("[DEV EMAIL] Verification email to:", email);
  console.log("[DEV EMAIL] Verify URL:", verifyUrl);

  return true;
}

/**
 * Validate and consume a verification token.
 */
export async function verifyEmailToken(
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { rows } = await pool.query(
    `
    SELECT user_id, email, expires_at
    FROM email_verification_tokens
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  if (rows.length === 0) {
    return { ok: false, error: "invalid_token" };
  }

  const record = rows[0] as VerificationTokenRecord;

  if (new Date() > record.expires_at) {
    return { ok: false, error: "expired" };
  }

  // Mark user as verified
  await pool.query(
    `UPDATE app_user SET is_verified = true WHERE id = $1`,
    [record.user_id]
  );

  // Consume the token
  await pool.query(
    `DELETE FROM email_verification_tokens WHERE token = $1`,
    [token]
  );

  return { ok: true };
}
