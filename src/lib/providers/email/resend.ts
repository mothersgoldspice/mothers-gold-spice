/**
 * Resend adapter.
 *
 * Chosen as the first real EmailProvider because it is a plain HTTPS API with no
 * SDK — AWS SES's SigV4 signing and Nodemailer's SMTP both need Node APIs that
 * Cloudflare Workers do not provide. Swapping to Postmark/Brevo/SES-via-HTTP is
 * a sibling file implementing the same interface.
 *
 * Requires RESEND_API_KEY and a verified sending domain for EMAIL_FROM.
 */

import { log, maskEmail } from '../../log';
import type { EmailProvider, OutgoingEmail, SendResult } from './types';

const API_BASE = 'https://api.resend.com';

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('ResendEmailProvider requires RESEND_API_KEY');
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    // Resend collapses retries of the same key for 24h, which pairs with the
    // outbox's own idempotency key to make a retried dispatch safe.
    if (email.idempotencyKey) headers['Idempotency-Key'] = email.idempotencyKey;

    const res = await fetch(`${API_BASE}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: email.from.name ? `${email.from.name} <${email.from.email}>` : email.from.email,
        to: [email.to.name ? `${email.to.name} <${email.to.email}>` : email.to.email],
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        text: email.text,
        html: email.html,
        tags: [{ name: 'template', value: email.template.replace(/[^a-zA-Z0-9_-]/g, '_') }],
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      log.error('email.resend.failed', {
        status: res.status,
        to: maskEmail(email.to.email),
        template: email.template,
        body: bodyText.slice(0, 400),
      });
      throw new Error(`Resend send failed (${res.status}): ${bodyText.slice(0, 300)}`);
    }

    let parsed: { id?: string } = {};
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // A 2xx with an unparseable body still means accepted; keep the id null.
    }

    log.info('email.resend.sent', {
      to: maskEmail(email.to.email),
      template: email.template,
      providerMessageId: parsed.id ?? null,
    });

    return { providerMessageId: parsed.id ?? null, provider: this.name, raw: parsed };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${API_BASE}/domains`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      return res.ok
        ? { ok: true }
        : { ok: false, detail: `Resend API returned ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
