"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
exports.sendSms = sendSms;
// server/src/services/notifications.ts
const nodemailer_1 = __importDefault(require("nodemailer"));
const axios_1 = __importDefault(require("axios"));
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
let mailer = null;
if (smtpHost && smtpPort) {
    mailer = nodemailer_1.default.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
    });
}
async function sendEmail(to, subject, htmlBody, textBody) {
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
        return { provider: 'nodemailer', id: info.messageId, success: true };
    }
    catch (err) {
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
async function sendSms(to, message) {
    // Normalize number if needed (caller should provide E.164)
    if (!to)
        return { provider: smsProvider, success: false, error: 'no_recipient' };
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
        // Twilio fallback
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        const from = process.env.TWILIO_FROM;
        try {
            const auth = Buffer.from(`${sid}:${token}`).toString('base64');
            const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
            const params = new URLSearchParams();
            params.append('To', to);
            params.append('From', from);
            params.append('Body', message);
            const r = await axios_1.default.post(url, params.toString(), {
                headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 8000,
            });
            return { provider: 'twilio', id: r.data?.sid, success: true };
        }
        catch (err) {
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
        const r = await axios_1.default.post(apiUrl, {
            to,
            message,
        }, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 8000,
        });
        return { provider: 'generic', id: r.data?.id || null, success: true };
    }
    catch (err) {
        return { provider: smsProvider, success: false, error: err?.message || String(err) };
    }
}
