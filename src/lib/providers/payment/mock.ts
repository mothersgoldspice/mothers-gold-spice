/**
 * MockPaymentProvider — a working fake payment gateway.
 *
 * This is not a stub that returns canned values. It behaves like a real hosted
 * gateway so the entire money path is exercisable before a single credential
 * exists:
 *
 *   • createCheckout persists a "transaction" and returns a hosted-page URL that
 *     points at our own /checkout/pay/[id] simulator.
 *   • The simulator lets you succeed, fail or abandon — and on success it emits a
 *     REAL webhook: HMAC-signed with the same scheme the adapter verifies, POSTed
 *     to the same /api/webhooks/payment endpoint Paddle would hit.
 *   • getPayment reads back the simulated transaction, so the checkout return
 *     page's poll-until-confirmed logic is the same code that will run in
 *     production.
 *
 * The consequence: switching PAYMENT_PROVIDER to `paddle` changes which adapter
 * signs the webhook, and nothing else. The order confirmation path has already
 * been run end-to-end thousands of times against this.
 */

import { hmacSha256Hex, timingSafeEqual } from '../../crypto';
import { log } from '../../log';
import type { MockStore } from '../mock-store';
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

/** Shape held in `mock_provider_state` for one simulated transaction. */
export interface MockTransaction {
  id: string;
  orderId: string;
  orderNumber: string;
  status: ProviderPaymentStatus;
  amountPaise: number;
  currency: string;
  customerEmail: string;
  customerId: string;
  method: string | null;
  paymentId: string | null;
  failureReason: string | null;
  refundedPaise: number;
  items: { name: string; quantity: number; unitAmountPaise: number }[];
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  createdAt: number;
  updatedAt: number;
}

export const MOCK_SIGNATURE_HEADER = 'x-mgs-mock-signature';

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly isHosted = true;

  constructor(
    private readonly store: MockStore,
    private readonly secret: string,
    private readonly siteUrl: string,
  ) {}

  private key(txnId: string): string {
    return `payment:${txnId}`;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const txnId = `mock_txn_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = Date.now();

    const txn: MockTransaction = {
      id: txnId,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      status: 'pending',
      amountPaise: input.amountPaise,
      currency: input.currency,
      customerEmail: input.customer.email,
      customerId: input.customer.providerCustomerId ?? `mock_cus_${crypto.randomUUID().slice(0, 12)}`,
      method: null,
      paymentId: null,
      failureReason: null,
      refundedPaise: 0,
      items: input.items.map((i) => ({ name: i.name, quantity: i.quantity, unitAmountPaise: i.unitAmountPaise })),
      metadata: { ...(input.metadata ?? {}), order_id: input.orderId, order_number: input.orderNumber },
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.put('payment', this.key(txnId), txn);
    log.info('payment.mock.checkout_created', { txnId, orderId: input.orderId, amountPaise: input.amountPaise });

    return {
      checkoutUrl: `${this.siteUrl}/checkout/pay/${txnId}`,
      providerCheckoutId: txnId,
      providerCustomerId: txn.customerId,
      raw: { mock: true },
    };
  }

  async getPayment(providerCheckoutId: string): Promise<PaymentSnapshot> {
    const txn = await this.store.get<MockTransaction>(this.key(providerCheckoutId));
    if (!txn) throw new Error(`MockPaymentProvider: unknown transaction ${providerCheckoutId}`);
    return {
      providerPaymentId: txn.paymentId,
      providerCheckoutId: txn.id,
      status: txn.status,
      amountPaise: txn.amountPaise,
      currency: txn.currency,
      method: txn.method,
      raw: txn,
    };
  }

  async refund(input: RefundInput): Promise<RefundOutcome> {
    // The simulator stores payment ids as `<txnId>:pay`, so the transaction is
    // recoverable from the payment id without a second index.
    const txnId = input.providerPaymentId.split(':')[0];
    const txn = await this.store.get<MockTransaction>(this.key(txnId));
    if (!txn) throw new Error(`MockPaymentProvider: unknown payment ${input.providerPaymentId}`);
    if (txn.status !== 'paid' && txn.status !== 'refunded') {
      throw new Error(`MockPaymentProvider: cannot refund a transaction with status ${txn.status}`);
    }

    const remaining = txn.amountPaise - txn.refundedPaise;
    const amount = Math.min(input.amountPaise ?? remaining, remaining);
    if (amount <= 0) throw new Error('MockPaymentProvider: nothing left to refund');

    txn.refundedPaise += amount;
    txn.status = txn.refundedPaise >= txn.amountPaise ? 'refunded' : txn.status;
    txn.updatedAt = Date.now();
    await this.store.put('payment', this.key(txnId), txn);

    log.info('payment.mock.refunded', { txnId, amountPaise: amount, reason: input.reason });
    return {
      providerRefundId: `mock_ref_${crypto.randomUUID().slice(0, 12)}`,
      amountPaise: amount,
      status: 'completed',
      raw: { mock: true },
    };
  }

  /**
   * Mirrors Paddle's scheme: `ts=<unix>;h1=<hex hmac of "ts:body">`. The
   * simulator signs with the same helper, so the verification code that will run
   * against Paddle in production is the code running today.
   */
  async verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent> {
    const header = headers.get(MOCK_SIGNATURE_HEADER) ?? '';
    if (!header) throw new Error('Mock payment webhook: missing signature header');

    const parts = Object.fromEntries(
      header
        .split(';')
        .map((p) => p.split('='))
        .filter((p) => p.length === 2) as [string, string][],
    );
    const ts = parts['ts'];
    const h1 = parts['h1'];
    if (!ts || !h1) throw new Error('Mock payment webhook: malformed signature header');

    // Same replay window Paddle recommends.
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > 300) throw new Error('Mock payment webhook: signature timestamp out of range');

    const expected = await hmacSha256Hex(this.secret, `${ts}:${rawBody}`);
    if (!timingSafeEqual(expected, h1)) throw new Error('Mock payment webhook: signature mismatch');

    return this.parseTrustedWebhook(rawBody);
  }

  async parseTrustedWebhook(rawBody: string): Promise<PaymentWebhookEvent> {
    const body = JSON.parse(rawBody) as {
      event_id?: string;
      event_type?: string;
      occurred_at?: number;
      data?: Record<string, unknown>;
    };
    const data = body.data ?? {};

    const map: Record<string, PaymentWebhookEvent['type']> = {
      'transaction.completed': 'payment.succeeded',
      'transaction.payment_failed': 'payment.failed',
      'transaction.canceled': 'payment.cancelled',
      'transaction.refunded': 'payment.refunded',
    };

    return {
      eventId: body.event_id ?? `mock_evt_${crypto.randomUUID()}`,
      type: map[body.event_type ?? ''] ?? 'unknown',
      providerEventName: body.event_type ?? 'unknown',
      orderId: (data['order_id'] as string) ?? null,
      providerCheckoutId: (data['transaction_id'] as string) ?? null,
      providerPaymentId: (data['payment_id'] as string) ?? null,
      providerCustomerId: (data['customer_id'] as string) ?? null,
      amountPaise: typeof data['amount_paise'] === 'number' ? (data['amount_paise'] as number) : null,
      currency: (data['currency'] as string) ?? null,
      method: (data['method'] as string) ?? null,
      failureReason: (data['failure_reason'] as string) ?? null,
      occurredAt: body.occurred_at ?? Date.now(),
      raw: body,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Mock gateway — checkout simulator at /checkout/pay/[transactionId]' };
  }

  // ── Simulator-only surface (called by the /checkout/pay page, never by services) ──

  async loadTransaction(txnId: string): Promise<MockTransaction | null> {
    return this.store.get<MockTransaction>(this.key(txnId));
  }

  /**
   * Advance a simulated transaction and return the webhook body + signature that
   * a real gateway would have POSTed. The caller delivers it to the webhook
   * route, so the confirmation path is identical to production.
   */
  async simulate(
    txnId: string,
    outcome: 'success' | 'failure' | 'cancel',
    method = 'upi',
  ): Promise<{ body: string; signatureHeader: string; headerName: string; transaction: MockTransaction }> {
    const txn = await this.store.get<MockTransaction>(this.key(txnId));
    if (!txn) throw new Error(`MockPaymentProvider: unknown transaction ${txnId}`);

    const now = Date.now();
    let eventType: string;
    if (outcome === 'success') {
      txn.status = 'paid';
      txn.method = method;
      txn.paymentId = `${txn.id}:pay`;
      eventType = 'transaction.completed';
    } else if (outcome === 'failure') {
      txn.status = 'failed';
      txn.failureReason = 'Simulated failure: card declined by issuing bank';
      eventType = 'transaction.payment_failed';
    } else {
      txn.status = 'cancelled';
      eventType = 'transaction.canceled';
    }
    txn.updatedAt = now;
    await this.store.put('payment', this.key(txnId), txn);

    const body = JSON.stringify({
      event_id: `mock_evt_${crypto.randomUUID()}`,
      event_type: eventType,
      occurred_at: now,
      data: {
        order_id: txn.orderId,
        order_number: txn.orderNumber,
        transaction_id: txn.id,
        payment_id: txn.paymentId,
        customer_id: txn.customerId,
        amount_paise: txn.amountPaise,
        currency: txn.currency,
        method: txn.method,
        failure_reason: txn.failureReason,
      },
    });

    const ts = Math.floor(now / 1000).toString();
    const signature = await hmacSha256Hex(this.secret, `${ts}:${body}`);

    return {
      body,
      signatureHeader: `ts=${ts};h1=${signature}`,
      headerName: MOCK_SIGNATURE_HEADER,
      transaction: txn,
    };
  }
}
