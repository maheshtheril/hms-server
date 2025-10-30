// server/src/services/notifications.ts
import nodemailer from 'nodemailer';
import axios from 'axios';

type SmsResult = { provider: string; id?: string; success: boolean; error?: string };
type EmailResult = { provider: string; id?: string; success: boolean; error?: string };

/* ------------------------- Email (nodemailer) --------------------------- */
/**
 * Configure:
 *   EMAIL_SMTP_HOST
 *   EMAIL_SMTP_PORT
 *   EMAIL_SMTP_USER
 *   EMAIL_SMTP_PASS
 *   EMAIL_FROM
 */
const smtpHost = process.env.EMAIL_SMTP_HOST;
const smtpPort = process.env.EMAIL_SMTP_PORT ? parseInt(process.env.EMAIL_SMTP_PORT) : undefined;
const smtpUser = process.env.EMAIL_SMTP_USER;
const smtpPass = process.env.EMAIL_SMTP_PASS;
const emailFrom = process.env.EMAIL_FROM || 'no-reply@yourorg.com';

let mailer: nodemailer.Transporter | null = null;
if (smtpHost && smtpPort) {
  mailer = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
  });
}

export async function sendEmail(to: string, subject: string, htmlBody: string, textBody?: string): Promise<EmailResult> {
  if (!mailer) {
    return { provider: 'nodemailer', success: false, error: 'smtp_not_configured' };
  }
  try {
    const info = await mailer.sendMail({
      from: emailFrom,
      to,
      subject,
      text: textBody,
      html: htmlBody,
    });
    return { provider: 'nodemailer', id: (info as any).messageId, success: true };
  } catch (err: any) {
    return { provider: 'nodemailer', success: false, error: err?.message || String(err) };
  }
}

/* ----------------------------- SMS (HTTP) ------------------------------ */
/**
 * Example config for a generic SMS provider:
 *   SMS_PROVIDER = "twilio" | "generic"
 *   SMS_API_URL (for generic)
 *   SMS_API_KEY (for generic)
 * For Twilio (recommended), provide TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *
 * This adapter supports a minimal generic HTTP provider and Twilio (if env set).
 */

const smsProvider = process.env.SMS_PROVIDER || 'generic';

export async function sendSms(to: string, message: string): Promise<SmsResult> {
  // Normalize number if needed (caller should provide E.164)
  if (!to) return { provider: smsProvider, success: false, error: 'no_recipient' };

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
    // Twilio fallback
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const token = process.env.TWILIO_AUTH_TOKEN!;
    const from = process.env.TWILIO_FROM!;
    try {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      const params = new URLSearchParams();
      params.append('To', to);
      params.append('From', from);
      params.append('Body', message);
      const r = await axios.post(url, params.toString(), {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      });
      return { provider: 'twilio', id: r.data?.sid, success: true };
    } catch (err: any) {
      return { provider: 'twilio', success: false, error: err?.message || String(err) };
    }
  }

  // Generic HTTP provider (requires SMS_API_URL & SMS_API_KEY)
  const apiUrl = process.env.SMS_API_URL;
  const apiKey = process.env.SMS_API_KEY;
  if (!apiUrl || !apiKey) {
    return { provider: smsProvider, success: false, error: 'sms_not_configured' };
  }

  try {
    const r = await axios.post(apiUrl, {
      to,
      message,
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    return { provider: 'generic', id: r.data?.id || null, success: true };
  } catch (err: any) {
    return { provider: smsProvider, success: false, error: err?.message || String(err) };
  }
}
