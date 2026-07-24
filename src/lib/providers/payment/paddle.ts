/**
 * Paddle Billing adapter.
 *
 * Maps our order-shaped checkout onto Paddle's transaction API using non-catalog
 * (inline) prices, because every order is a different basket — there is no
 * per-SKU price entity to reference. Amounts cross the boundary as integer paise
 * and Paddle wants a minor-unit string, so the conversion is a `String(paise)`
 * and nothing else has to think about it.
 *
 * Configuration: PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_ENVIRONMENT
 * (`sandbox` | `production`), optional PADDLE_PRODUCT_ID to attach inline prices
 * to an existing catalog product.
 *
 * Docs: https://developer.paddle.com/api-reference/transactions/create-transaction
 *       https://developer.paddle.com/webhooks/signature-verification
 */

import { hmacSha256Hex, timingSafeEqual } from '../../crypto';
import { log, maskEmail } from '../../log';
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

export interface PaddleConfig {
  apiKey: string;
  webhookSecret: string;
  environment: 'sandbox' | 'production';
  /** Attach inline prices to this catalog product when set. */
  productId?: string | null;
  /**
   * Replay window for webhook signatures, seconds. Paddle's own SDKs default to
   * 5s; we allow more because true replay defence here is the UNIQUE (provider,
   * event_id) constraint on `webhook_events` — a replayed body is rejected as a
   * duplicate regardless of its age. Widening the clock tolerance therefore buys
   * resilience to skew without weakening idempotency.
   */
  toleranceSeconds?: number;
}

interface PaddleTransaction {
  id: string;
  status: string;
  customer_id: string | null;
  currency_code: string;
  checkout?: { url?: string | null } | null;
  details?: { totals?: { total?: string; grand_total?: string } };
  payments?: { payment_method_id?: string; method_details?: { type?: string }; status?: string }[];
  custom_data?: Record<string, unknown> | null;
}

/** Paddle transaction status → our normalised payment status. */
const STATUS_MAP: Record<string, ProviderPaymentStatus> = {
  draft: 'pending',
  ready: 'pending',
  billed: 'authorized',
  paid: 'paid',
  completed: 'paid',
  canceled: 'cancelled',
  past_due: 'failed',
};

const EVENT_MAP: Record<string, PaymentWebhookEvent['type']> = {
  'transaction.completed': 'payment.succeeded',
  'transaction.paid': 'payment.succeeded',
  'transaction.payment_failed': 'payment.failed',
  'transaction.canceled': 'payment.cancelled',
  'adjustment.created': 'payment.refunded',
  'adjustment.updated': 'payment.refunded',
};

export class PaddlePaymentProvider implements PaymentProvider {
  readonly name = 'paddle';
  readonly isHosted = true;

  private readonly base: string;
  private readonly tolerance: number;

  constructor(private readonly config: PaddleConfig) {
    if (!config.apiKey) throw new Error('PaddlePaymentProvider requires PADDLE_API_KEY');
    if (!config.webhookSecret) throw new Error('PaddlePaymentProvider requires PADDLE_WEBHOOK_SECRET');
    this.base = config.environment === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
    this.tolerance = config.toleranceSeconds ?? 300;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      log.error('payment.paddle.api_error', { path, status: res.status, body: text.slice(0, 500) });
      throw new Error(`Paddle ${init.method ?? 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  /**
   * Paddle needs a `customer_id` before a transaction leaves `draft` (and a
   * draft has no checkout URL). Creating a customer that already exists returns
   * a conflict, so that case falls back to a lookup by email.
   */
  private async resolveCustomerId(email: string, name?: string): Promise<string> {
    try {
      const created = await this.api<{ data: { id: string } }>('/customers', {
        method: 'POST',
        body: JSON.stringify({ email, ...(name ? { name } : {}) }),
      });
      return created.data.id;
    } catch (err) {
      log.info('payment.paddle.customer_exists_or_failed', { email: maskEmail(email) });
      const found = await this.api<{ data: { id: string; email: string }[] }>(
        `/customers?email=${encodeURIComponent(email)}&status=active`,
      );
      const match = found.data.find((c) => c.email.toLowerCase() === email.toLowerCase());
      if (!match) throw err;
      return match.id;
    }
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const customerId = input.customer.providerCustomerId || (await this.resolveCustomerId(input.customer.email, input.customer.name));

    const items = input.items.map((item) => ({
      quantity: item.quantity,
      price: {
        // Paddle requires 2-500 chars here.
        description: (item.description || `${item.name}${item.sku ? ` (${item.sku})` : ''}`).slice(0, 500),
        name: item.name.slice(0, 150),
        unit_price: { amount: String(item.unitAmountPaise), currency_code: input.currency },
        ...(this.config.productId
          ? { product_id: this.config.productId }
          : { product: { name: item.name.slice(0, 150), tax_category: 'standard' } }),
      },
    }));

    if (input.shippingPaise > 0) {
      items.push({
        quantity: 1,
        price: {
          description: 'Shipping & handling',
          name: 'Shipping',
          unit_price: { amount: String(input.shippingPaise), currency_code: input.currency },
          ...(this.config.productId
            ? { product_id: this.config.productId }
            : { product: { name: 'Shipping', tax_category: 'standard' } }),
        },
      });
    }

    const body: Record<string, unknown> = {
      items,
      customer_id: customerId,
      currency_code: input.currency,
      collection_mode: 'automatic',
      // Echoed back verbatim on every webhook for this transaction — this is how
      // an inbound event is reconciled to one of our orders.
      custom_data: {
        order_id: input.orderId,
        order_number: input.orderNumber,
        ...(input.metadata ?? {}),
      },
      checkout: { url: input.successUrl },
    };
    if (input.providerDiscountId) body['discount_id'] = input.providerDiscountId;

    const created = await this.api<{ data: PaddleTransaction }>('/transactions', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const url = created.data.checkout?.url;
    if (!url) {
      throw new Error(`Paddle returned transaction ${created.data.id} with no checkout URL (status=${created.data.status})`);
    }

    log.info('payment.paddle.checkout_created', { transactionId: created.data.id, orderId: input.orderId });
    return {
      checkoutUrl: url,
      providerCheckoutId: created.data.id,
      providerCustomerId: created.data.customer_id ?? customerId,
      raw: created.data,
    };
  }

  async getPayment(providerCheckoutId: string): Promise<PaymentSnapshot> {
    const res = await this.api<{ data: PaddleTransaction }>(
      `/transactions/${encodeURIComponent(providerCheckoutId)}`,
    );
    const txn = res.data;
    const total = txn.details?.totals?.grand_total ?? txn.details?.totals?.total ?? '0';
    const payment = txn.payments?.find((p) => p.status === 'captured') ?? txn.payments?.[0];

    return {
      providerPaymentId: payment?.payment_method_id ?? null,
      providerCheckoutId: txn.id,
      status: STATUS_MAP[txn.status] ?? 'pending',
      amountPaise: Number.parseInt(total, 10) || 0,
      currency: txn.currency_code,
      method: payment?.method_details?.type ?? null,
      raw: txn,
    };
  }

  /**
   * Paddle models refunds as adjustments, which are asynchronous and require
   * approval for card payments — hence a `pending` status rather than an
   * immediate `completed`. The `adjustment.updated` webhook settles it.
   */
  async refund(input: RefundInput): Promise<RefundOutcome> {
    const transactionId = input.providerPaymentId;
    const txn = await this.api<{ data: PaddleTransaction & { items?: { id?: string }[] } }>(
      `/transactions/${encodeURIComponent(transactionId)}`,
    );

    const itemId = txn.data.items?.[0]?.id;
    if (!itemId) throw new Error(`Paddle transaction ${transactionId} has no refundable items`);

    const adjustment = await this.api<{ data: { id: string; totals?: { total?: string }; status?: string } }>(
      '/adjustments',
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'refund',
          transaction_id: transactionId,
          reason: input.reason ?? 'Customer refund',
          items: [
            input.amountPaise === undefined
              ? { item_id: itemId, type: 'full' }
              : { item_id: itemId, type: 'partial', amount: String(input.amountPaise) },
          ],
        }),
      },
    );

    return {
      providerRefundId: adjustment.data.id,
      amountPaise: Number.parseInt(adjustment.data.totals?.total ?? '0', 10) || (input.amountPaise ?? 0),
      status: adjustment.data.status === 'approved' ? 'completed' : 'pending',
      raw: adjustment.data,
    };
  }

  async verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent> {
    const header = headers.get('paddle-signature') ?? '';
    if (!header) throw new Error('Paddle webhook: missing Paddle-Signature header');

    const parts = Object.fromEntries(
      header
        .split(';')
        .map((p) => p.split('='))
        .filter((p): p is [string, string] => p.length === 2),
    );
    const ts = parts['ts'];
    const h1 = parts['h1'];
    if (!ts || !h1) throw new Error('Paddle webhook: malformed Paddle-Signature header');

    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > this.tolerance) {
      throw new Error(`Paddle webhook: timestamp outside ${this.tolerance}s tolerance`);
    }

    // The raw body must be hashed byte-for-byte as received — re-serialising
    // parsed JSON here would change the payload and never match.
    const expected = await hmacSha256Hex(this.config.webhookSecret, `${ts}:${rawBody}`);
    if (!timingSafeEqual(expected, h1.toLowerCase())) throw new Error('Paddle webhook: signature mismatch');

    return this.parseTrustedWebhook(rawBody);
  }

  async parseTrustedWebhook(rawBody: string): Promise<PaymentWebhookEvent> {
    const body = JSON.parse(rawBody) as {
      event_id?: string;
      event_type?: string;
      occurred_at?: string;
      data?: Record<string, unknown>;
    };
    const data = (body.data ?? {}) as Record<string, unknown>;
    const custom = (data['custom_data'] ?? {}) as Record<string, unknown>;
    const details = data['details'] as { totals?: { grand_total?: string; total?: string } } | undefined;
    const payments = data['payments'] as
      | { payment_method_id?: string; method_details?: { type?: string }; error_code?: string }[]
      | undefined;
    const payment = payments?.[0];

    const totalStr = details?.totals?.grand_total ?? details?.totals?.total;
    const amountPaise = totalStr ? Number.parseInt(totalStr, 10) : null;

    // Refund adjustments carry the transaction id rather than being one.
    const isAdjustment = (body.event_type ?? '').startsWith('adjustment.');
    const checkoutId = isAdjustment ? ((data['transaction_id'] as string) ?? null) : ((data['id'] as string) ?? null);

    return {
      eventId: body.event_id ?? `paddle_${checkoutId}_${body.event_type}`,
      type: EVENT_MAP[body.event_type ?? ''] ?? 'unknown',
      providerEventName: body.event_type ?? 'unknown',
      orderId: typeof custom['order_id'] === 'string' ? (custom['order_id'] as string) : null,
      providerCheckoutId: checkoutId,
      providerPaymentId: isAdjustment ? ((data['id'] as string) ?? null) : (payment?.payment_method_id ?? checkoutId),
      providerCustomerId: (data['customer_id'] as string) ?? null,
      amountPaise: Number.isFinite(amountPaise) ? amountPaise : null,
      currency: (data['currency_code'] as string) ?? null,
      method: payment?.method_details?.type ?? null,
      failureReason: payment?.error_code ?? null,
      occurredAt: body.occurred_at ? Date.parse(body.occurred_at) : Date.now(),
      raw: body,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.api('/event-types');
      return { ok: true, detail: `Paddle ${this.config.environment}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
