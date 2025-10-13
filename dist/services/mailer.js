"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVerifyEmail = sendVerifyEmail;
// server/src/services/mailer.ts
async function sendVerifyEmail(opts) {
    // TODO: plug your provider (Nodemailer/Resend/SES)
    console.log("[mailer] sendVerifyEmail →", opts);
    return { ok: true };
}
