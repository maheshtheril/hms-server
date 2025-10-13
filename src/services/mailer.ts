// server/src/services/mailer.ts
export async function sendVerifyEmail(opts: {
  to: string;
  name?: string;
  verifyUrl: string;
}) {
  // TODO: plug your provider (Nodemailer/Resend/SES)
  console.log("[mailer] sendVerifyEmail →", opts);
  return { ok: true };
}
