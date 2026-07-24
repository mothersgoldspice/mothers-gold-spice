/**
 * Shiprocket adapter.
 *
 * Shiprocket's flow is three calls where most aggregators have one: create the
 * order (adhoc), assign an AWB from a serviceable courier, then request pickup.
 * `createShipment` performs all three so the rest of the system sees a single
 * "book this parcel" operation — the sequencing is a Shiprocket detail and stays
 * behind the interface.
 *
 * Auth is an email/password login returning a bearer token valid ~10 days. Logging
 * in on every request would be both slow and rate-limited, so the token is cached
 * through an injected `TokenCache` (D1-backed) rather than a module variable,
 * which would not survive between Worker invocations.
 *
 * Configuration: SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD, SHIPROCKET_PICKUP_LOCATION,
 * SHIPROCKET_WEBHOOK_TOKEN.
 */

import { timingSafeEqual } from '../../crypto';
import { log } from '../../log';
import { paiseToRupees, rupeesToPaise } from '../../money';
import { ZONE_ETD_DAYS, zoneForPincode } from '../../shipping-zones';
import type {
  CreateShipmentInput,
  CreateShipmentResult,
  ServiceabilityQuery,
  ServiceabilityResult,
  ShipmentProvider,
  ShipmentWebhookEvent,
  TrackingEvent,
  TrackingResult,
  TrackingStatus,
} from './types';

const API_BASE = 'https://apiv2.shiprocket.in/v1/external';

export interface TokenCache {
  get(): Promise<{ token: string; expiresAt: number } | null>;
  set(token: string, expiresAt: number): Promise<void>;
}

export interface ShiprocketConfig {
  email: string;
  password: string;
  /** Pickup nickname configured in the Shiprocket dashboard. */
  pickupLocation: string;
  /** Shared secret configured on the Shiprocket webhook, sent as `x-api-key`. */
  webhookToken: string;
  originPincode?: string;
}

/**
 * Shiprocket reports free-text statuses that vary by courier. Everything is
 * normalised to our closed `TrackingStatus` set; an unrecognised status maps to
 * `in_transit` rather than throwing, because a courier inventing a new scan code
 * must never wedge the tracking pipeline.
 */
const STATUS_MAP: Record<string, TrackingStatus> = {
  'awb assigned': 'created',
  'label generated': 'created',
  'pickup scheduled': 'pickup_scheduled',
  'pickup generated': 'pickup_scheduled',
  'pickup queued': 'pickup_scheduled',
  'pickup rescheduled': 'pickup_scheduled',
  'out for pickup': 'pickup_scheduled',
  'picked up': 'picked_up',
  shipped: 'picked_up',
  'in transit': 'in_transit',
  'reached at destination hub': 'in_transit',
  'misroute': 'in_transit',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
  'undelivered': 'failed_delivery',
  'delivery failed': 'failed_delivery',
  'rto initiated': 'rto_initiated',
  'rto in transit': 'rto_initiated',
  'rto acknowledged': 'rto_initiated',
  'rto delivered': 'rto_delivered',
  canceled: 'cancelled',
  cancelled: 'cancelled',
};

function normaliseStatus(raw: string | null | undefined): TrackingStatus {
  if (!raw) return 'in_transit';
  return STATUS_MAP[raw.trim().toLowerCase()] ?? 'in_transit';
}

export class ShiprocketProvider implements ShipmentProvider {
  readonly name = 'shiprocket';

  constructor(
    private readonly config: ShiprocketConfig,
    private readonly tokenCache: TokenCache,
  ) {
    if (!config.email || !config.password) {
      throw new Error('ShiprocketProvider requires SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD');
    }
  }

  private async token(): Promise<string> {
    const cached = await this.tokenCache.get();
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Shiprocket login failed (${res.status}): ${text.slice(0, 200)}`);

    const parsed = JSON.parse(text) as { token?: string };
    if (!parsed.token) throw new Error('Shiprocket login returned no token');

    // Documented lifetime is 10 days; refresh at 9 to stay clear of the edge.
    const expiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000;
    await this.tokenCache.set(parsed.token, expiresAt);
    log.info('shipping.shiprocket.token_refreshed');
    return parsed.token;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token();
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      log.error('shipping.shiprocket.api_error', { path, status: res.status, body: text.slice(0, 400) });
      throw new Error(`Shiprocket ${init.method ?? 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  async checkServiceability(query: ServiceabilityQuery): Promise<ServiceabilityResult> {
    const params = new URLSearchParams({
      pickup_postcode: this.config.originPincode ?? '560001',
      delivery_postcode: query.deliveryPincode,
      // Shiprocket quotes in kilograms.
      weight: (query.weightGrams / 1000).toFixed(2),
      cod: query.cod ? '1' : '0',
      declared_value: String(paiseToRupees(query.declaredValuePaise)),
    });

    interface Company {
      courier_company_id: number | string;
      courier_name: string;
      rate: number;
      etd_hours?: number;
      estimated_delivery_days?: string;
      cod: number | string;
      rating?: number;
    }

    let data: { data?: { available_courier_companies?: Company[] } };
    try {
      data = await this.api(`/courier/serviceability/?${params.toString()}`);
    } catch (err) {
      // A 404 from this endpoint means "no courier serves this pincode", which is
      // an answer rather than an outage — surface it as unserviceable.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('(404)')) {
        return { serviceable: false, codAvailable: false, quotes: [], zone: zoneForPincode(query.deliveryPincode) };
      }
      throw err;
    }

    const companies = data.data?.available_courier_companies ?? [];
    const quotes = companies
      .map((c) => ({
        courierId: String(c.courier_company_id),
        courierName: c.courier_name,
        ratePaise: rupeesToPaise(c.rate),
        estimatedDays: c.estimated_delivery_days
          ? Number.parseInt(c.estimated_delivery_days, 10) || null
          : c.etd_hours
            ? Math.ceil(c.etd_hours / 24)
            : null,
        codAvailable: String(c.cod) === '1',
        rating: c.rating ?? null,
      }))
      .sort((a, b) => a.ratePaise - b.ratePaise);

    return {
      serviceable: quotes.length > 0,
      codAvailable: quotes.some((q) => q.codAvailable),
      quotes,
      zone: zoneForPincode(query.deliveryPincode),
      raw: data,
    };
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const addr = input.shippingAddress;
    const billing = input.billingAddress;

    // 1. Create the order. Shiprocket wants rupees and kilograms.
    const orderPayload = {
      order_id: input.orderNumber,
      order_date: new Date(input.placedAt).toISOString().slice(0, 19).replace('T', ' '),
      pickup_location: this.config.pickupLocation,
      billing_customer_name: billing.full_name.split(' ')[0] || billing.full_name,
      billing_last_name: billing.full_name.split(' ').slice(1).join(' '),
      billing_address: billing.line1,
      billing_address_2: billing.line2 ?? '',
      billing_city: billing.city,
      billing_pincode: billing.pincode,
      billing_state: billing.state,
      billing_country: 'India',
      billing_email: billing.email ?? '',
      billing_phone: billing.phone.replace(/\D/g, '').slice(-10),
      shipping_is_billing: JSON.stringify(addr) === JSON.stringify(billing),
      shipping_customer_name: addr.full_name.split(' ')[0] || addr.full_name,
      shipping_last_name: addr.full_name.split(' ').slice(1).join(' '),
      shipping_address: addr.line1,
      shipping_address_2: addr.line2 ?? '',
      shipping_city: addr.city,
      shipping_pincode: addr.pincode,
      shipping_country: 'India',
      shipping_state: addr.state,
      shipping_email: addr.email ?? '',
      shipping_phone: addr.phone.replace(/\D/g, '').slice(-10),
      order_items: input.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        units: i.quantity,
        selling_price: paiseToRupees(i.unitPricePaise),
        discount: paiseToRupees(i.discountPaise ?? 0),
        tax: paiseToRupees(i.taxPaise ?? 0),
        hsn: i.hsnCode ?? '',
      })),
      payment_method: input.codAmountPaise > 0 ? 'COD' : 'Prepaid',
      shipping_charges: paiseToRupees(input.shippingChargePaise),
      total_discount: paiseToRupees(input.discountPaise),
      sub_total: paiseToRupees(input.subtotalPaise),
      length: input.package.lengthCm,
      breadth: input.package.breadthCm,
      height: input.package.heightCm,
      weight: Number((input.package.weightGrams / 1000).toFixed(2)),
    };

    const created = await this.api<{ order_id: number; shipment_id: number; status?: string }>(
      '/orders/create/adhoc',
      { method: 'POST', body: JSON.stringify(orderPayload) },
    );

    const providerOrderId = String(created.order_id);
    const providerShipmentId = String(created.shipment_id);

    // 2. Assign an AWB. Omitting courier_id lets Shiprocket pick the cheapest
    // serviceable courier, which is the behaviour we want by default.
    let awbCode: string | null = null;
    let courierName: string | null = null;
    let chargesPaise = 0;
    try {
      const awb = await this.api<{
        response?: { data?: { awb_code?: string; courier_name?: string; freight_charges?: number } };
      }>('/courier/assign/awb', {
        method: 'POST',
        body: JSON.stringify({
          shipment_id: [Number(providerShipmentId)],
          ...(input.courierId ? { courier_id: Number(input.courierId) } : {}),
        }),
      });
      awbCode = awb.response?.data?.awb_code ?? null;
      courierName = awb.response?.data?.courier_name ?? null;
      chargesPaise = rupeesToPaise(awb.response?.data?.freight_charges ?? 0);
    } catch (err) {
      // The order exists in Shiprocket even without an AWB; an operator can
      // assign one from the dashboard. Failing the whole booking here would
      // strand a paid order with no shipment row at all.
      log.warn('shipping.shiprocket.awb_assign_failed', {
        providerShipmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Request pickup — best effort for the same reason.
    if (awbCode) {
      try {
        await this.schedulePickup(providerShipmentId);
      } catch (err) {
        log.warn('shipping.shiprocket.pickup_failed', {
          providerShipmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const zone = zoneForPincode(addr.pincode);
    return {
      providerOrderId,
      providerShipmentId,
      awbCode,
      courierName,
      labelUrl: null, // fetched on demand via generateLabel
      trackingUrl: awbCode ? `https://shiprocket.co/tracking/${awbCode}` : null,
      estimatedDeliveryAt: Date.now() + ZONE_ETD_DAYS[zone] * 24 * 60 * 60 * 1000,
      chargesPaise,
      raw: created,
    };
  }

  async schedulePickup(providerShipmentId: string): Promise<{ scheduledFor: number | null; raw?: unknown }> {
    const res = await this.api<{ response?: { pickup_scheduled_date?: string } }>('/courier/generate/pickup', {
      method: 'POST',
      body: JSON.stringify({ shipment_id: [Number(providerShipmentId)] }),
    });
    const date = res.response?.pickup_scheduled_date;
    return { scheduledFor: date ? Date.parse(date) : null, raw: res };
  }

  async generateLabel(providerShipmentId: string): Promise<{ labelUrl: string | null; raw?: unknown }> {
    const res = await this.api<{ label_url?: string }>('/courier/generate/label', {
      method: 'POST',
      body: JSON.stringify({ shipment_id: [Number(providerShipmentId)] }),
    });
    return { labelUrl: res.label_url ?? null, raw: res };
  }

  async track(params: { awbCode?: string | null; providerShipmentId?: string | null }): Promise<TrackingResult> {
    const path = params.awbCode
      ? `/courier/track/awb/${encodeURIComponent(params.awbCode)}`
      : `/courier/track/shipment/${encodeURIComponent(String(params.providerShipmentId))}`;

    interface Activity {
      date?: string;
      activity?: string;
      location?: string;
      'sr-status-label'?: string;
      status?: string;
    }
    const res = await this.api<{
      tracking_data?: {
        track_status?: number;
        shipment_status?: string;
        shipment_track?: { current_status?: string; courier_name?: string; edd?: string; delivered_date?: string }[];
        shipment_track_activities?: Activity[];
      };
    }>(path);

    const data = res.tracking_data ?? {};
    const head = data.shipment_track?.[0];
    const activities = data.shipment_track_activities ?? [];

    const events: TrackingEvent[] = activities
      .map((a, index) => ({
        status: normaliseStatus(a['sr-status-label'] ?? a.status ?? a.activity),
        description: a.activity ?? '',
        location: a.location ?? null,
        occurredAt: a.date ? Date.parse(a.date.replace(' ', 'T')) || Date.now() : Date.now(),
        providerEventId: `${params.awbCode ?? params.providerShipmentId}:${index}`,
        raw: a,
      }))
      .sort((a, b) => a.occurredAt - b.occurredAt);

    return {
      status: normaliseStatus(head?.current_status ?? data.shipment_status),
      awbCode: params.awbCode ?? null,
      courierName: head?.courier_name ?? null,
      estimatedDeliveryAt: head?.edd ? Date.parse(head.edd) || null : null,
      deliveredAt: head?.delivered_date ? Date.parse(head.delivered_date) || null : null,
      events,
      raw: res,
    };
  }

  async cancelShipment(providerOrderId: string, providerShipmentId: string): Promise<void> {
    // Cancel the AWB first (releases the courier booking), then the order.
    try {
      await this.api('/orders/cancel/shipment/awbs', {
        method: 'POST',
        body: JSON.stringify({ awbs: [providerShipmentId] }),
      });
    } catch (err) {
      log.warn('shipping.shiprocket.awb_cancel_failed', {
        providerShipmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.api('/orders/cancel', { method: 'POST', body: JSON.stringify({ ids: [Number(providerOrderId)] }) });
  }

  /**
   * Shiprocket authenticates webhooks with a static `x-api-key` you configure in
   * their dashboard — there is no HMAC. It is compared in constant time, and an
   * unset token is fatal rather than "allow": a webhook endpoint that accepts
   * anonymous POSTs would let anyone mark any parcel delivered.
   */
  async verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<ShipmentWebhookEvent> {
    if (!this.config.webhookToken) {
      throw new Error('Shiprocket webhook: SHIPROCKET_WEBHOOK_TOKEN is not configured');
    }
    const presented = headers.get('x-api-key') ?? '';
    if (!presented || !timingSafeEqual(presented, this.config.webhookToken)) {
      throw new Error('Shiprocket webhook: invalid x-api-key');
    }

    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const awb = (body['awb'] as string) ?? null;
    const status = (body['current_status'] as string) ?? (body['shipment_status'] as string) ?? null;
    const scanTime = (body['current_timestamp'] as string) ?? (body['scan_date'] as string) ?? null;

    return {
      eventId:
        (body['event_id'] as string) ??
        `sr_${awb ?? 'unknown'}_${status ?? 'unknown'}_${scanTime ?? String(Date.now())}`,
      providerShipmentId: body['shipment_id'] != null ? String(body['shipment_id']) : null,
      awbCode: awb,
      orderReference: (body['order_id'] as string) ?? null,
      status: normaliseStatus(status),
      description: (body['activity'] as string) ?? (status ?? ''),
      location: (body['location'] as string) ?? null,
      occurredAt: scanTime ? Date.parse(scanTime.replace(' ', 'T')) || Date.now() : Date.now(),
      courierName: (body['courier_name'] as string) ?? null,
      raw: body,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.token();
      return { ok: true, detail: 'Shiprocket token acquired' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
