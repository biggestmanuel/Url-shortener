/**
 * Transactional email delivery.
 *
 * Supports any SMTP server via nodemailer. When nothing is configured, the
 * message is logged instead, so a self-hosted instance remains usable (and
 * password resets remain reachable) without wiring up a mail provider.
 */

import 'dotenv/config';

let transport = null;
let transportChecked = false;

/**
 * Lazily builds the SMTP transport. Returns null when unconfigured.
 */
async function getTransport() {
  if (transportChecked) return transport;
  transportChecked = true;

  const host = process.env.SMTP_HOST;
  if (!host) return null;

  try {
    const { createTransport } = await import('nodemailer');
    transport = createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
  } catch (err) {
    console.error(
      'SMTP_HOST is set but nodemailer is not installed.',
      err.message,
      'Run: npm --prefix backend install nodemailer'
    );
    return null;
  }

  return transport;
}

/**
 * Test seam: captures messages instead of sending them.
 *
 * @param {{subjectIncludes?: string, to?: string}} [filter]
 * @returns {{sent: Array<{to: string, subject: string, text: string}>, reset: () => void}}
 */
export function createCapturingMailer(filter = {}) {
  const sent = [];

  return {
    sent,
    reset() {
      sent.length = 0;
    },
    async sendMail(message) {
      const subject = message.subject || '';
      const matchesSubject = !filter.subjectIncludes || subject.includes(filter.subjectIncludes);
      const matchesTo = !filter.to || message.to === filter.to;

      if (matchesSubject && matchesTo) sent.push(message);
      return { sent: true, via: 'smtp' };
    },
  };
}

/** Finds a captured message and returns its text body. */
export function findToken(sent, purpose) {
  for (const message of sent) {
    const match = new RegExp(`${purpose}\\.[A-Za-z0-9_-]{20,}`).exec(message.text || '');
    if (match) return match[0];
  }
  return null;
}

/**
 * Sends a message.
 *
 * Never throws: a failed email must not take down the endpoint that triggered
 * it, and the caller must not be able to distinguish transport failures.
 *
 * @returns {Promise<{sent: boolean, via: 'smtp'|'log'}>}
 */
export async function sendMail({ to, subject, text, html }) {
  if (!to) return { sent: false, via: 'log' };

  const smtp = await getTransport();

  if (!smtp) {
    // Console fallback: the message body is the only place the token exists
    // outside the request that generated it.
    console.log(
      [
        '',
        '─── Linkly email (no SMTP configured; logged instead) ───',
        `to:      ${to}`,
        `subject: ${subject}`,
        '',
        text,
        '─────────────────────────────────────────────────────────',
        '',
      ].join('\n')
    );
    return { sent: false, via: 'log' };
  }

  try {
    await smtp.sendMail({
      from: process.env.SMTP_FROM || 'Linkly <no-reply@linkly.invalid>',
      to,
      subject,
      text,
      html,
    });
    return { sent: true, via: 'smtp' };
  } catch (err) {
    console.error('sendMail failed:', err.message);
    return { sent: false, via: 'log' };
  }
}

export function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST);
}