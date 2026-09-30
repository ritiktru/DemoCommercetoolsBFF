import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createResetMailer } from '../src/mailer.js';
import { loadConfig } from '../src/config.js';

const base = { CT_PROJECT_KEY: 'p', CT_CLIENT_ID: 'c', CT_CLIENT_SECRET: 's', CT_AUTH_URL: 'https://auth.example.com', CT_API_URL: 'https://api.example.com', CT_SCOPES: 'manage_customers:p' };

test('no SMTP_HOST means no mailer; SMTP_HOST needs MAIL_FROM; user and pass go together', () => {
  assert.equal(createResetMailer(loadConfig({ ...base, SMTP_HOST: '' })), undefined);
  assert.throws(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com' }), /MAIL_FROM/);
  assert.throws(() => loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@b.co', SMTP_USER: 'u' }), /SMTP_USER and SMTP_PASS/);
});

test('reset email carries the link, sender and recipient', async () => {
  const config = loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'Shop <no-reply@example.com>' });
  const sent: Array<{ from: string; to: string; text: string }> = [];
  const transport = nodemailer.createTransport({ jsonTransport: true }); const original = transport.sendMail.bind(transport);
  transport.sendMail = (async (mail: never) => { const info = await original(mail); sent.push(JSON.parse(info.message)); return info; }) as typeof transport.sendMail;
  await createResetMailer(config, transport)!('who@example.com', 'https://shop.example.com/reset-password?token=abc');
  assert.match(sent[0]!.text, /reset-password\?token=abc/);
  assert.match(JSON.stringify(sent[0]!.to), /who@example.com/);
  assert.match(JSON.stringify(sent[0]!.from), /no-reply@example.com/);
});
