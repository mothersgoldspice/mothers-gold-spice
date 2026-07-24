/**
 * MockEmailProvider — accepts every message and stores nothing of its own.
 *
 * The durable copy already exists: `email_outbox` holds the row before the
 * provider is called, so the admin "Inbox" at /admin/emails renders real,
 * fully-rendered messages with no vendor account attached. That makes the mock
 * genuinely useful rather than a black hole — you can read exactly what a
 * customer would have received, including the live links.
 *
 * A `MOCK_EMAIL_FAIL_TO` address is honoured so the outbox retry/backoff path
 * can be exercised deliberately instead of only when a real provider breaks.
 */

import { log, maskEmail } from '../../log';
import type { EmailProvider, OutgoingEmail, SendResult } from './types';

export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';

  /** Any recipient matching this substring throws, to exercise retries. */
  constructor(private readonly failRecipientSubstring: string | null = null) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    if (this.failRecipientSubstring && email.to.email.includes(this.failRecipientSubstring)) {
      throw new Error(`MockEmailProvider: simulated delivery failure for ${maskEmail(email.to.email)}`);
    }

    log.info('email.mock.sent', {
      to: maskEmail(email.to.email),
      subject: email.subject,
      template: email.template,
    });

    return {
      providerMessageId: `mock_msg_${crypto.randomUUID()}`,
      provider: this.name,
      raw: { accepted: true, mock: true },
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Mock provider — messages are stored in email_outbox and viewable in /admin/emails' };
  }
}
