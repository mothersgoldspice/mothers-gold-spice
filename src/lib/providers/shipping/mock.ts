/**
 * MockShipmentProvider — a working fake courier aggregator.
 *
 * Like the mock gateway, this simulates the vendor rather than returning canned
 * values: it quotes from the real zone rate table, mints a plausible AWB, keeps
 * the parcel's state, and can be advanced through the scan lifecycle. Advancing
 * emits a REAL signed webhook to /api/webhooks/shipping, so the tracking
 * pipeline exercised in testing is the one Shiprocket will drive in production.
 *
 * Serviceability answers are deliberately opinionated rather than "yes to
 * everything": a handful of pincode ranges are non-serviceable and remote zones
 * refuse COD, which is what the real network does and what the checkout UI has
 * to handle gracefully.
 */

import { hmacSha256Hex, timingSafeEqual } from '../../crypto';
import { log } from '../../log';
import {
  ZONE_COURIER_COST_PAISE,
  ZONE_ETD_DAYS,
  isValidPincode,
  weightSlabs,
  zoneForPincode,
} from '../../shipping-zones';
import type { MockStore } from '../mock-store';
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

export const MOCK_SHIPPING_SIGNATURE_HEADER = 'x-mgs-mock-signature';

export interface MockShipment {
  providerOrderId: string;
  providerShipmentId: string;
  awbCode: string;
  courierName: string;
  orderId: string;
  orderNumber: string;
  status: TrackingStatus;
  codAmountPaise: number;
  chargesPaise: number;
  weightGrams: number;
  destinationPincode: string;
  destinationCity: string;
  estimatedDeliveryAt: number;
  deliveredAt: number | null;
  events: TrackingEvent[];
  createdAt: number;
  updatedAt: number;
}

/** The happy path a parcel walks, in order. */
export const MOCK_LIFECYCLE: TrackingStatus[] = [
  'created',
  'pickup_scheduled',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
];

const COURIERS = [
  { id: '10', name: 'Delhivery Surface', speed: 1.0, rating: 4.4 },
  { id: '24', name: 'Bluedart Express', speed: 0.6, rating: 4.7 },
  { id: '51', name: 'DTDC Surface', speed: 1.1, rating: 4.1 },
  { id: '63', name: 'Ekart Logistics', speed: 1.0, rating: 4.2 },
];

/** Deliberately dead pincodes so the "we don't deliver there yet" path is testable. */
const NON_SERVICEABLE_PREFIXES = ['191', '192', '193', '194'];

export class MockShipmentProvider implements ShipmentProvider {
  readonly name = 'mock';

  constructor(
    private readonly store: MockStore,
    private readonly secret: string,
  ) {}

  private key(id: string): string {
    return `shipment:${id}`;
  }

  async checkServiceability(query: ServiceabilityQuery): Promise<ServiceabilityResult> {
    if (!isValidPincode(query.deliveryPincode)) {
      return { serviceable: false, codAvailable: false, quotes: [], zone: null };
    }

    const zone = zoneForPincode(query.deliveryPincode);
    const prefix = query.deliveryPincode.slice(0, 3);
    if (NON_SERVICEABLE_PREFIXES.includes(prefix)) {
      log.info('shipping.mock.not_serviceable', { pincode: query.deliveryPincode });
      return { serviceable: false, codAvailable: false, quotes: [], zone };
    }

    // Remote zones are prepaid-only in practice: RTO on a COD parcel to Ladakh
    // costs more than the jar.
    const codAvailable = query.cod ? zone !== 'E' : false;
    if (query.cod && !codAvailable) {
      return { serviceable: true, codAvailable: false, quotes: [], zone };
    }

    const slabs = weightSlabs(query.weightGrams);
    const table = ZONE_COURIER_COST_PAISE[zone];
    const base = table.first500g + (slabs - 1) * table.perExtra500g;

    const quotes = COURIERS.map((c) => ({
      courierId: c.id,
      courierName: c.name,
      // Express couriers cost more and arrive sooner; the multiplier is the
      // inverse of the speed factor so the ordering is realistic.
      ratePaise: Math.round(base * (1 + (1 - c.speed) * 0.8)) + (query.cod ? 3000 : 0),
      estimatedDays: Math.max(1, Math.round(ZONE_ETD_DAYS[zone] * c.speed)),
      codAvailable: codAvailable && zone !== 'E',
      rating: c.rating,
    })).sort((a, b) => a.ratePaise - b.ratePaise);

    return {
      serviceable: true,
      codAvailable,
      quotes,
      zone,
      city: null,
      state: null,
      raw: { mock: true },
    };
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const now = Date.now();
    const zone = zoneForPincode(input.shippingAddress.pincode);
    const courier = COURIERS.find((c) => c.id === input.courierId) ?? COURIERS[0];

    const slabs = weightSlabs(input.package.weightGrams);
    const table = ZONE_COURIER_COST_PAISE[zone];
    const chargesPaise = table.first500g + (slabs - 1) * table.perExtra500g;

    const providerShipmentId = `mock_shp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const awbCode = `MGS${String(now).slice(-9)}${Math.floor(Math.random() * 90 + 10)}`;
    const estimatedDeliveryAt = now + ZONE_ETD_DAYS[zone] * 24 * 60 * 60 * 1000;

    const shipment: MockShipment = {
      providerOrderId: `mock_ord_${input.orderNumber}`,
      providerShipmentId,
      awbCode,
      courierName: courier.name,
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      status: 'created',
      codAmountPaise: input.codAmountPaise,
      chargesPaise,
      weightGrams: input.package.weightGrams,
      destinationPincode: input.shippingAddress.pincode,
      destinationCity: input.shippingAddress.city,
      estimatedDeliveryAt,
      deliveredAt: null,
      events: [
        {
          status: 'created',
          description: 'Shipment booked. Awaiting courier pickup.',
          location: 'Bengaluru, KA',
          occurredAt: now,
          providerEventId: `${providerShipmentId}:0`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    await this.store.put('shipment', this.key(providerShipmentId), shipment);
    // Second key so a webhook carrying only the AWB can find the parcel.
    await this.store.put('shipment', this.key(`awb:${awbCode}`), { ref: providerShipmentId });

    log.info('shipping.mock.created', { providerShipmentId, awbCode, orderId: input.orderId, zone });

    return {
      providerOrderId: shipment.providerOrderId,
      providerShipmentId,
      awbCode,
      courierName: courier.name,
      labelUrl: `/admin/shipments/${providerShipmentId}/label`,
      trackingUrl: `/track/awb/${awbCode}`,
      estimatedDeliveryAt,
      chargesPaise,
      raw: { mock: true },
    };
  }

  async schedulePickup(providerShipmentId: string): Promise<{ scheduledFor: number | null }> {
    const shipment = await this.load(providerShipmentId);
    const scheduledFor = Date.now() + 4 * 60 * 60 * 1000;
    if (shipment.status === 'created') {
      await this.appendEvent(shipment, 'pickup_scheduled', 'Pickup scheduled with courier.', 'Bengaluru, KA');
    }
    return { scheduledFor };
  }

  async generateLabel(providerShipmentId: string): Promise<{ labelUrl: string | null }> {
    await this.load(providerShipmentId); // 404s on an unknown parcel, like the real API
    return { labelUrl: `/admin/shipments/${providerShipmentId}/label` };
  }

  async track(params: { awbCode?: string | null; providerShipmentId?: string | null }): Promise<TrackingResult> {
    const shipment = await this.resolve(params);
    return {
      status: shipment.status,
      awbCode: shipment.awbCode,
      courierName: shipment.courierName,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt,
      deliveredAt: shipment.deliveredAt,
      events: [...shipment.events].sort((a, b) => a.occurredAt - b.occurredAt),
      raw: { mock: true },
    };
  }

  async cancelShipment(_providerOrderId: string, providerShipmentId: string): Promise<void> {
    const shipment = await this.load(providerShipmentId);
    if (shipment.status === 'delivered') throw new Error('Cannot cancel a delivered shipment');
    await this.appendEvent(shipment, 'cancelled', 'Shipment cancelled.', null);
  }

  async verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<ShipmentWebhookEvent> {
    const header = headers.get(MOCK_SHIPPING_SIGNATURE_HEADER) ?? '';
    if (!header) throw new Error('Mock shipping webhook: missing signature header');

    const parts = Object.fromEntries(
      header
        .split(';')
        .map((p) => p.split('='))
        .filter((p): p is [string, string] => p.length === 2),
    );
    const ts = parts['ts'];
    const h1 = parts['h1'];
    if (!ts || !h1) throw new Error('Mock shipping webhook: malformed signature header');

    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > 300) throw new Error('Mock shipping webhook: timestamp out of range');

    const expected = await hmacSha256Hex(this.secret, `${ts}:${rawBody}`);
    if (!timingSafeEqual(expected, h1)) throw new Error('Mock shipping webhook: signature mismatch');

    const body = JSON.parse(rawBody) as Record<string, unknown>;
    return {
      eventId: (body['event_id'] as string) ?? `mock_shipevt_${crypto.randomUUID()}`,
      providerShipmentId: (body['shipment_id'] as string) ?? null,
      awbCode: (body['awb'] as string) ?? null,
      orderReference: (body['order_id'] as string) ?? null,
      status: (body['status'] as TrackingStatus) ?? 'in_transit',
      description: (body['description'] as string) ?? '',
      location: (body['location'] as string) ?? null,
      occurredAt: (body['occurred_at'] as number) ?? Date.now(),
      courierName: (body['courier_name'] as string) ?? null,
      raw: body,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'Mock courier — advance parcels from /admin/shipments' };
  }

  // ── Simulator-only surface ────────────────────────────────────────────────

  async load(providerShipmentId: string): Promise<MockShipment> {
    const shipment = await this.store.get<MockShipment>(this.key(providerShipmentId));
    if (!shipment) throw new Error(`MockShipmentProvider: unknown shipment ${providerShipmentId}`);
    return shipment;
  }

  private async resolve(params: { awbCode?: string | null; providerShipmentId?: string | null }): Promise<MockShipment> {
    if (params.providerShipmentId) return this.load(params.providerShipmentId);
    if (params.awbCode) {
      const ref = await this.store.get<{ ref: string }>(this.key(`awb:${params.awbCode}`));
      if (ref?.ref) return this.load(ref.ref);
    }
    throw new Error('MockShipmentProvider: track requires an awbCode or providerShipmentId');
  }

  /**
   * Move a parcel one step along the lifecycle and return the webhook a courier
   * would have fired, signed with the scheme `verifyAndParseWebhook` checks.
   */
  async advance(
    providerShipmentId: string,
    to?: TrackingStatus,
  ): Promise<{ body: string; signatureHeader: string; headerName: string; shipment: MockShipment } | null> {
    const shipment = await this.load(providerShipmentId);
    const currentIndex = MOCK_LIFECYCLE.indexOf(shipment.status);
    const next = to ?? MOCK_LIFECYCLE[currentIndex + 1];
    if (!next) return null; // already delivered / terminal

    const descriptions: Record<TrackingStatus, string> = {
      created: 'Shipment booked. Awaiting courier pickup.',
      pickup_scheduled: 'Pickup scheduled with courier.',
      picked_up: `Picked up from Bengaluru hub by ${shipment.courierName}.`,
      in_transit: `In transit to ${shipment.destinationCity}.`,
      out_for_delivery: `Out for delivery in ${shipment.destinationCity}.`,
      delivered: 'Delivered. Thank you for ordering from Mother’s Gold Spice.',
      failed_delivery: 'Delivery attempt failed — recipient unavailable.',
      rto_initiated: 'Return to origin initiated.',
      rto_delivered: 'Returned to origin.',
      cancelled: 'Shipment cancelled.',
    };

    const location =
      next === 'picked_up' || next === 'created' || next === 'pickup_scheduled'
        ? 'Bengaluru, KA'
        : `${shipment.destinationCity} (${shipment.destinationPincode})`;

    const updated = await this.appendEvent(shipment, next, descriptions[next], location);
    const event = updated.events[updated.events.length - 1];

    const body = JSON.stringify({
      event_id: event.providerEventId,
      shipment_id: updated.providerShipmentId,
      awb: updated.awbCode,
      order_id: updated.orderNumber,
      status: next,
      description: event.description,
      location: event.location,
      occurred_at: event.occurredAt,
      courier_name: updated.courierName,
    });

    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = await hmacSha256Hex(this.secret, `${ts}:${body}`);
    return {
      body,
      signatureHeader: `ts=${ts};h1=${signature}`,
      headerName: MOCK_SHIPPING_SIGNATURE_HEADER,
      shipment: updated,
    };
  }

  private async appendEvent(
    shipment: MockShipment,
    status: TrackingStatus,
    description: string,
    location: string | null,
  ): Promise<MockShipment> {
    const now = Date.now();
    shipment.status = status;
    shipment.updatedAt = now;
    if (status === 'delivered') shipment.deliveredAt = now;
    shipment.events.push({
      status,
      description,
      location,
      occurredAt: now,
      providerEventId: `${shipment.providerShipmentId}:${shipment.events.length}`,
    });
    await this.store.put('shipment', this.key(shipment.providerShipmentId), shipment);
    return shipment;
  }
}
