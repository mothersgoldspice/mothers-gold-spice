/**
 * Razorpay adapter (Payment Links).
 *
 * Shipped alongside Paddle because it is the provider this business will most
 * likely actually run on: Paddle is a merchant of record built for digital
 * goods, while a Bangalore sole proprietorship selling glass jars of pickle
 * needs UPI, Indian cards, and COD reconciliation. Having two real adapters is
 * also the proof that the PaymentProvider seam works — the order, cart and
 * refund code below is byte-identical under either.
 *
 * Payment Links rather than Checkout.js: the interface promises a hosted URL we
 * can redirect to, and a link's `short_url` is exactly that, with no client SDK
 * to load and no key material in the browser.
 *
 * Configuration: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET.
 */

import { hmacSha256Hex, timingSafeEqual } from '../../crypto';
import { log } from '../../log';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  PaymentProvider,
  PaymentSnapshot,
  PaymentWebhookEvent,
  ProviderPaymentStatus,
  RefundInput,
  RefundOutcome,
} from './types';

const API_BASE = 'https://api.razorpay.com/v1';

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

const LINK_STATUS_MAP: Record<string, ProviderPaymentStatus> = {
  created: 'pending',
  partially_paid: 'pending',
  paid: 'paid',
  expired: 'cancelled',
  cancelled: 'cancelled',
};

const EVENT_MAP: Record<string, PaymentWebhookEvent['type']> = {
  'payment_link.paid': 'payment.succeeded',
  'payment.captured': 'payment.succeeded',
  'payment.failed': 'payment.failed',
  'payment_link.cancelled': 'payment.cancelled',
  'payment_link.expired': 'payment.cancelled',
  'refund.processed': 'payment.refunded',
  'refund.created': 'payment.refunded',
};

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly isHosted = true;

  private readonly authHeader: string;

  constructor(private readonly config: RazorpayConfig) {
    if (!config.keyId || !config.keySecret) {
      throw new Error('RazorpayPaymentProvider requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    if (!config.webhookSecret) {
      throw new Error('RazorpayPaymentProvider requires RAZORPAY_WEBHOOK_SECRET');
    }
    this.authHeader = `Basic ${btoa(`${config.keyId}:${config.keySecret}`)}`;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      log.error('payment.razorpay.api_error', { path, status: res.status, body: text.slice(0, 400) });
      throw new Error(`Razorpay ${init.method ?? 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const description = input.items
      .map((i) => `${i.quantity}× ${i.name}`)
      .join(', ')
      .slice(0, 2048);

    const link = await this.api<{ id: string; short_url: string; customer?: { contact?: string } }>(
      '/payment_links',
      {
        method: 'POST',
        body: JSON.stringify({
          // Razorpay's native unit for INR is already paise, so no conversion.
          amount: input.amountPaise,
          currency: input.currency,
          accept_partial: false,
          description: description || `Order ${input.orderNumber}`,
          reference_id: input.orderNumber,
          customer: {
            name: input.customer.name ?? '',
            email: input.customer.email,
            ...(input.customer.phone ? { contact: input.customer.phone } : {}),
          },
          // We send our own transactional mail from the outbox; letting Razorpay
          // also notify would double up on every order.
          notify: { sms: false, email: false },
          reminder_enable: false,
          callback_url: input.successUrl,
          callback_method: 'get',
          notes: {
            order_id: input.orderId,
            order_number: input.orderNumber,
            ...(input.metadata ?? {}),
          },
        }),
      },
    );

    log.info('payment.razorpay.link_created', { linkId: link.id, orderId: input.orderId });
    return {
      checkoutUrl: link.short_url,
      providerCheckoutId: link.id,
      providerCustomerId: null,
      raw: link,
    };
  }

  async getPayment(providerCheckoutId: string): Promise<PaymentSnapshot> {
    const link = await this.api<{
      id: string;
      status: string;
      amount: number;
      amount_paid: number;
      currency: string;
      payments?: { payment_id: string; method?: string; status?: string }[];
    }>(`/payment_links/${encodeURIComponent(providerCheckoutId)}`);

    const payment = link.payments?.find((p) => p.status === 'captured') ?? link.payments?.[0];
    return {
      providerPaymentId: payment?.payment_id ?? null,
      providerCheckoutId: link.id,
      status: LINK_STATUS_MAP[link.status] ?? 'pending',
      amountPaise: link.amount,
      currency: link.currency,
      method: payment?.method ?? null,
      raw: link,
    };
  }

  async refund(input: RefundInput): Promise<RefundOutcome> {
    const refund = await this.api<{ id: string; amount: number; status: string }>(
      `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(input.amountPaise !== undefined ? { amount: input.amountPaise } : {}),
          speed: 'normal',
          notes: { reason: input.reason ?? 'Customer refund' },
        }),
      },
    );

    return {
      providerRefundId: refund.id,
      amountPaise: refund.amount,
      status: refund.status === 'processed' ? 'completed' : refund.status === 'failed' ? 'failed' : 'pending',
      raw: refund,
    };
  }

  /**
   * Razorpay signs the raw body directly — no timestamp component, so there is
   * no clock-skew window to tune. Replay protection comes entirely from the
   * UNIQUE (provider, event_id) constraint on `webhook_events`.
   */
  async verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent> {
    const signature = headers.get('x-razorpay-signature') ?? '';
    if (!signature) throw new Error('Razorpay webhook: missing X-Razorpay-Signature header');

    const expected = await hmacSha256Hex(this.config.webhookSecret, rawBody);
    if (!timingSafeEqual(expected, signature.trim().toLowerCase())) {
      throw new Error('Razorpay webhook: signature mismatch');
    }
    return this.parseTrustedWebhook(rawBody);
  }

  async parseTrustedWebhook(rawBody: string): Promise<PaymentWebhookEvent> {
    const body = JSON.parse(rawBody) as {
      event?: string;
      created_at?: number;
      payload?: {
        payment?: { entity?: Record<string, unknown> };
        payment_link?: { entity?: Record<string, unknown> };
        refund?: { entity?: Record<string, unknown> };
      };
    };

    const payment = body.payload?.payment?.entity ?? {};
    const link = body.payload?.payment_link?.entity ?? {};
    const refund = body.payload?.refund?.entity ?? {};

    // `notes` rides on whichever entity the event is about.
    const notes = ((link['notes'] ?? payment['notes'] ?? refund['notes']) ?? {}) as Record<string, unknown>;
    const amount = (refund['amount'] ?? payment['amount'] ?? link['amount']) as number | undefined;

    return {
      eventId:
        (body.payload?.payment?.entity?.['id'] as string) ??
        (link['id'] as string) ??
        `rzp_${body.event}_${body.created_at}`,
      type: EVENT_MAP[body.event ?? ''] ?? 'unknown',
      providerEventName: body.event ?? 'unknown',
      orderId: typeof notes['order_id'] === 'string' ? (notes['order_id'] as string) : null,
      providerCheckoutId: (link['id'] as string) ?? (payment['payment_link_id'] as string) ?? null,
      providerPaymentId: (payment['id'] as string) ?? (refund['payment_id'] as string) ?? null,
      providerCustomerId: (payment['customer_id'] as string) ?? null,
      amountPaise: typeof amount === 'number' ? amount : null,
      currency: (payment['currency'] as string) ?? (link['currency'] as string) ?? 'INR',
      method: (payment['method'] as string) ?? null,
      failureReason: (payment['error_description'] as string) ?? null,
      occurredAt: body.created_at ? body.created_at * 1000 : Date.now(),
      raw: body,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.api('/payments?count=1');
      return { ok: true, detail: `Razorpay (${this.config.keyId.startsWith('rzp_live') ? 'live' : 'test'})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
