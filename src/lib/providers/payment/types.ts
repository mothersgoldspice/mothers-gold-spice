/**
 * PaymentProvider — the only way money is ever collected or returned.
 *
 * Nothing outside `src/lib/providers/payment/` may import a payment SDK or know
 * a provider's field names. Order/checkout code speaks only in the types below,
 * so moving from Paddle to Razorpay to Stripe is a new adapter file plus
 * `PAYMENT_PROVIDER=<name>` — no change to how an order is priced, confirmed or
 * refunded.
 *
 * Two rules the adapters must honour, because the order state machine depends
 * on them:
 *
 *  1. Amounts crossing this boundary are ALWAYS integer paise. Adapters convert
 *     to whatever decimal/string form their vendor wants, internally.
 *  2. `verifyAndParseWebhook` must reject an unsigned or badly-signed payload by
 *     throwing. Returning an event from an unverified body would let anyone mark
 *     any order paid by POSTing to the webhook URL.
 */

export interface PaymentCustomer {
  email: string;
  name?: string;
  phone?: string;
  /** Provider-side customer id from a previous order, when we have one. */
  providerCustomerId?: string | null;
}

export interface CheckoutLineItem {
  name: string;
  description?: string;
  sku?: string;
  quantity: number;
  /** Per-unit price in paise, tax-inclusive (Indian MRP convention). */
  unitAmountPaise: number;
}

export interface CreateCheckoutInput {
  /** Our order id — echoed back on the webhook to reconcile. */
  orderId: string;
  orderNumber: string;
  /** Amount actually to be collected, in paise, after discounts and shipping. */
  amountPaise: number;
  currency: string;
  customer: PaymentCustomer;
  items: CheckoutLineItem[];
  /** Shipping charged on the order, in paise (0 when free). */
  shippingPaise: number;
  discountPaise: number;
  successUrl: string;
  cancelUrl: string;
  /** Provider-side discount id, when a coupon was mirrored to the provider. */
  providerDiscountId?: string | null;
  metadata?: Record<string, string>;
}

export interface CreateCheckoutResult {
  /** Where to send the buyer. */
  checkoutUrl: string;
  /** Provider's id for the checkout/transaction — stored on `payments`. */
  providerCheckoutId: string;
  providerCustomerId: string | null;
  /**
   * True when the provider has no hosted page and the buyer stays on our site
   * (mock mode, or an inline SDK). Checkout renders a local confirm step instead
   * of redirecting off-site.
   */
  isInline?: boolean;
  raw?: unknown;
}

export type ProviderPaymentStatus = 'pending' | 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refunded';

export interface PaymentSnapshot {
  providerPaymentId: string | null;
  providerCheckoutId: string;
  status: ProviderPaymentStatus;
  amountPaise: number;
  currency: string;
  method: string | null;
  raw?: unknown;
}

export interface RefundInput {
  /** Provider payment/transaction id being refunded. */
  providerPaymentId: string;
  /** Paise to refund. Omit for a full refund. */
  amountPaise?: number;
  reason?: string;
}

export interface RefundOutcome {
  providerRefundId: string;
  amountPaise: number;
  status: 'pending' | 'completed' | 'failed';
  raw?: unknown;
}

/**
 * Normalised webhook event. Adapters map their vendor's taxonomy onto this
 * closed set — the order service switches on `type` and never sees a provider
 * event name.
 */
export type PaymentEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'payment.refunded'
  | 'unknown';

export interface PaymentWebhookEvent {
  /** Provider's own event id — the idempotency key for `webhook_events`. */
  eventId: string;
  type: PaymentEventType;
  /** Raw vendor event name, kept for the audit log. */
  providerEventName: string;
  /** Our order id, recovered from metadata/custom data. Null if unattributable. */
  orderId: string | null;
  providerCheckoutId: string | null;
  providerPaymentId: string | null;
  providerCustomerId: string | null;
  amountPaise: number | null;
  currency: string | null;
  method: string | null;
  failureReason?: string | null;
  occurredAt: number;
  raw: unknown;
}

export interface PaymentProvider {
  /** Adapter name recorded on `payments.provider`. */
  readonly name: string;

  /** Whether the buyer is redirected off-site (hosted page) or stays on ours. */
  readonly isHosted: boolean;

  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;

  /**
   * Authoritative read of a payment's state. Used by the checkout return page:
   * the buyer usually lands back before the webhook arrives, so the return page
   * polls this rather than guessing from a URL parameter.
   */
  getPayment(providerCheckoutId: string): Promise<PaymentSnapshot>;

  refund(input: RefundInput): Promise<RefundOutcome>;

  /**
   * Verify the signature on a raw request body, then normalise it.
   * MUST throw when the signature is missing, malformed or wrong.
   */
  verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<PaymentWebhookEvent>;

  /**
   * Re-parse a payload that was already verified and persisted (an operator
   * replaying a stuck `webhook_events` row). The trust boundary is our own
   * stored row, so no signature is re-checked — which is exactly why this is a
   * separate method rather than a `skipVerify` flag someone could pass from a
   * request handler.
   */
  parseTrustedWebhook(rawBody: string): Promise<PaymentWebhookEvent>;

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
