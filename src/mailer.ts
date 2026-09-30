import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from './config.js';

// Sends the password-reset link over SMTP. Returns undefined when SMTP is not configured.
export function createResetMailer(config: Config, transport?: Transporter): ((email: string, link: string) => Promise<void>) | undefined {
  if (!config.SMTP_HOST || !config.MAIL_FROM) return undefined;
  const from = config.MAIL_FROM;
  const smtp = transport ?? nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE === 'true',
    ...(config.SMTP_USER && { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }),
    connectionTimeout: 10000, socketTimeout: 15000,
  });
  return async (email, link) => {
    await smtp.sendMail({
      from, to: email, subject: 'Reset your password',
      text: `We received a request to reset your password.\n\nChoose a new password: ${link}\n\nThis link expires in 30 minutes. If you did not ask for this, ignore this email.`,
      html: `<p>We received a request to reset your password.</p><p><a href="${link}">Choose a new password</a></p><p>This link expires in 30 minutes. If you did not ask for this, ignore this email.</p>`,
    });
  };
}
