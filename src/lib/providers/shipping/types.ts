/**
 * ShipmentProvider — the only way a parcel is quoted, booked, tracked or cancelled.
 *
 * Shiprocket is the launch aggregator, but the brand starts hyperlocal in
 * Bangalore (Porter / self-delivery) and will outgrow one courier, so nothing
 * outside this folder may know a Shiprocket field name. Swapping to Delhivery
 * Direct, Nimbuspost, or a hand-rolled "we drove it there ourselves" provider is
 * a new file implementing this interface.
 *
 * Weights cross the boundary in GRAMS and money in PAISE. Adapters convert to
 * whatever their vendor wants (Shiprocket bills in kilograms and rupees).
 */

import type { AddressSnapshot } from '../../db/types';

export interface ServiceabilityQuery {
  pickupPincode: string;
  deliveryPincode: string;
  weightGrams: number;
  /** Cash on delivery requested — changes which couriers are eligible. */
  cod: boolean;
  declaredValuePaise: number;
}

export interface CourierQuote {
  courierId: string;
  courierName: string;
  /** What the courier charges us, in paise. Not what we charge the customer. */
  ratePaise: number;
  estimatedDays: number | null;
  codAvailable: boolean;
  /** Provider's own rating, 0-5, when exposed. Used to pick a default. */
  rating?: number | null;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  codAvailable: boolean;
  /** Cheapest-first. Empty when `serviceable` is false. */
  quotes: CourierQuote[];
  /** Our internal zone letter (A–E) — drives the customer-facing shipping price. */
  zone: string | null;
  city?: string | null;
  state?: string | null;
  raw?: unknown;
}

export interface ShipmentPackage {
  weightGrams: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

export interface ShipmentLineItem {
  name: string;
  sku: string;
  quantity: number;
  unitPricePaise: number;
  discountPaise?: number;
  taxPaise?: number;
  hsnCode?: string | null;
}

export interface CreateShipmentInput {
  orderId: string;
  orderNumber: string;
  placedAt: number;
  pickupLocationName: string;
  shippingAddress: AddressSnapshot;
  billingAddress: AddressSnapshot;
  items: ShipmentLineItem[];
  subtotalPaise: number;
  shippingChargePaise: number;
  discountPaise: number;
  totalPaise: number;
  /** Amount to collect on delivery, paise. 0 for prepaid. */
  codAmountPaise: number;
  package: ShipmentPackage;
  /** Preferred courier from a prior serviceability call; provider picks if absent. */
  courierId?: string | null;
}

export interface CreateShipmentResult {
  providerOrderId: string;
  providerShipmentId: string;
  awbCode: string | null;
  courierName: string | null;
  labelUrl: string | null;
  trackingUrl: string | null;
  estimatedDeliveryAt: number | null;
  chargesPaise: number;
  raw?: unknown;
}

/** Normalised parcel state. Adapters map every vendor status onto this set. */
export type TrackingStatus =
  | 'created'
  | 'pickup_scheduled'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed_delivery'
  | 'rto_initiated'
  | 'rto_delivered'
  | 'cancelled';

export interface TrackingEvent {
  status: TrackingStatus;
  description: string;
  location: string | null;
  occurredAt: number;
  /** Stable per-event id where the vendor provides one; used for dedupe. */
  providerEventId: string | null;
  raw?: unknown;
}

export interface TrackingResult {
  status: TrackingStatus;
  awbCode: string | null;
  courierName: string | null;
  estimatedDeliveryAt: number | null;
  deliveredAt: number | null;
  /** Oldest-first. */
  events: TrackingEvent[];
  raw?: unknown;
}

export interface ShipmentWebhookEvent {
  eventId: string;
  providerShipmentId: string | null;
  awbCode: string | null;
  /** Our order number, echoed by the courier. */
  orderReference: string | null;
  status: TrackingStatus;
  description: string;
  location: string | null;
  occurredAt: number;
  courierName: string | null;
  raw: unknown;
}

export interface ShipmentProvider {
  /** Adapter name recorded on `shipments.provider`. */
  readonly name: string;

  checkServiceability(query: ServiceabilityQuery): Promise<ServiceabilityResult>;

  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;

  /** Book the courier pickup. Separate from creation because it is retryable. */
  schedulePickup(providerShipmentId: string): Promise<{ scheduledFor: number | null; raw?: unknown }>;

  /** Printable label PDF. */
  generateLabel(providerShipmentId: string): Promise<{ labelUrl: string | null; raw?: unknown }>;

  track(params: { awbCode?: string | null; providerShipmentId?: string | null }): Promise<TrackingResult>;

  cancelShipment(providerOrderId: string, providerShipmentId: string): Promise<void>;

  /**
   * Verify and normalise a courier callback. MUST throw on a bad/absent token —
   * an unauthenticated caller must not be able to mark parcels delivered.
   */
  verifyAndParseWebhook(rawBody: string, headers: Headers): Promise<ShipmentWebhookEvent>;

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
