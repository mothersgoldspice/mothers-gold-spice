/**
 * EmailProvider — the only way anything in this codebase sends mail.
 *
 * No service, route or template may import a vendor SDK directly. The active
 * adapter is resolved once per request from `EMAIL_PROVIDER`, so swapping Resend
 * for SES, Postmark or Brevo is a config change plus one new file implementing
 * this interface — never an edit to order/auth/notification logic.
 *
 * Delivery durability deliberately does NOT live in the adapter: every message is
 * written to `email_outbox` first and a dispatcher hands queued rows to the
 * provider. An adapter is therefore a pure "put this on the wire" function that
 * may throw; retries, backoff and suppression are the outbox's job.
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface OutgoingEmail {
  to: EmailAddress;
  from: EmailAddress;
  replyTo?: string;
  subject: string;
  /** Plain-text part. Always populated — some clients and most spam filters want it. */
  text: string;
  /** HTML part. */
  html: string;
  /** Template identifier for logging/analytics, e.g. `order_confirmation`. */
  template: string;
  /** Structured context that produced the body; stored for debugging. */
  data?: Record<string, unknown>;
  /** Collapses duplicate sends at the provider when it supports it. */
  idempotencyKey?: string;
}

export interface SendResult {
  /** Provider's message id, when it returns one. */
  providerMessageId: string | null;
  /** Which adapter actually sent it — recorded on the outbox row. */
  provider: string;
  /** Provider response, trimmed, for the admin delivery log. */
  raw?: unknown;
}

export interface EmailProvider {
  /** Adapter name as recorded in `email_outbox.provider` (`mock`, `resend`, …). */
  readonly name: string;

  /**
   * Put one message on the wire.
   *
   * MUST throw on failure — the outbox interprets a throw as "retry later" and
   * a return as "delivered to the provider". Returning normally after a failed
   * send would silently drop a customer's order confirmation.
   */
  send(email: OutgoingEmail): Promise<SendResult>;

  /**
   * Whether this adapter can reach its backing service right now. Used by the
   * admin health panel; a `false` here is why an outbox may be backing up.
   */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
