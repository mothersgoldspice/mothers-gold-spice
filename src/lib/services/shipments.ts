/**
 * Shipments: quoting, booking, tracking and courier callbacks.
 *
 * The courier is reached only through `ctx.shipping` (a `ShipmentProvider`), so
 * moving from Shiprocket to a direct Delhivery account — or to "we delivered it
 * on a scooter" — changes one env var and adds one adapter file.
 *
 * Tracking is the noisiest surface in the system: couriers re-send the same scan
 * repeatedly and occasionally out of order. Two defences: `shipment_events` has a
 * UNIQUE (shipment_id, provider_event_id) so a repeat is a no-op insert, and
 * order transitions are validated by the order state machine, which refuses to
 * walk an order backwards.
 */

import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { parseJson } from '../db/client';
import type { AddressSnapshot, OrderItemRow, OrderRow, ShipmentEventRow, ShipmentRow } from '../db/types';
import { badRequest, conflict, notFound, providerError } from '../errors';
import { newId } from '../ids';
import { errMessage, log } from '../log';
import type {
  ServiceabilityResult,
  ShipmentWebhookEvent,
  TrackingEvent,
  TrackingStatus,
} from '../providers/shipping/types';
import type { StoreSettings } from '../settings';
import { ZONE_ETD_DAYS, zoneForPincode } from '../shipping-zones';
import { getOrderById, orderEventStatement, transitionOrder } from './orders';
import { onOrderDelivered, onOrderShipped, onOutForDelivery } from './order-notifications';

/** How long a serviceability answer stays good enough to reuse. */
const PINCODE_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Can we deliver there, and is COD available?
 *
 * Cached in `pincode_cache` because this sits on the checkout critical path and
 * a courier API round trip per keystroke would both be slow and burn quota. A
 * stale-but-present answer is better than a spinner: serviceability changes on
 * the scale of weeks.
 */
export async function checkServiceability(
  ctx: AppContext,
  pincode: string,
  opts: { weightGrams: number; declaredValuePaise: number; cod: boolean },
): Promise<ServiceabilityResult> {
  const cached = await ctx.db.first<{
    serviceable: number;
    cod_available: number;
    zone: string | null;
    city: string | null;
    state: string | null;
    etd_days: number | null;
    refreshed_at: number;
  }>('SELECT * FROM pincode_cache WHERE pincode = ?', [pincode]);

  if (cached && Date.now() - cached.refreshed_at < PINCODE_CACHE_TTL_MS) {
    return {
      serviceable: cached.serviceable === 1,
      codAvailable: cached.cod_available === 1,
      quotes: [],
      zone: cached.zone,
      city: cached.city,
      state: cached.state,
    };
  }

  let result: ServiceabilityResult;
  try {
    result = await ctx.shipping.checkServiceability({
      pickupPincode: (await ctx.settings()).originPincode,
      deliveryPincode: pincode,
      weightGrams: opts.weightGrams,
      cod: opts.cod,
      declaredValuePaise: opts.declaredValuePaise,
    });
  } catch (err) {
    log.warn('shipments.serviceability_failed', { pincode, error: errMessage(err) });
    // Falling back to "we deliver, zone computed locally" is deliberate: a
    // courier API outage must not block every checkout in the country. The
    // parcel is still booked by hand if the courier genuinely cannot serve it.
    const zone = zoneForPincode(pincode);
    return {
      serviceable: true,
      codAvailable: opts.cod && zone !== 'E',
      quotes: [],
      zone,
      city: cached?.city ?? null,
      state: cached?.state ?? null,
    };
  }

  const cheapest = result.quotes[0];
  await ctx.db.run(
    `INSERT INTO pincode_cache (pincode, serviceable, cod_available, zone, city, state, etd_days, provider, raw_json, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
     ON CONFLICT (pincode) DO UPDATE SET serviceable = excluded.serviceable, cod_available = excluded.cod_available,
       zone = excluded.zone, city = excluded.city, state = excluded.state, etd_days = excluded.etd_days,
       provider = excluded.provider, refreshed_at = excluded.refreshed_at`,
    [
      pincode,
      result.serviceable ? 1 : 0,
      result.codAvailable ? 1 : 0,
      result.zone,
      result.city ?? null,
      result.state ?? null,
      cheapest?.estimatedDays ?? null,
      ctx.shipping.name,
      Date.now(),
    ],
  );

  return result;
}

export async function getShipmentForOrder(db: Db, orderId: string): Promise<ShipmentRow | null> {
  return db.first<ShipmentRow>(
    "SELECT * FROM shipments WHERE order_id = ? AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1",
    [orderId],
  );
}

export async function listShipmentEvents(db: Db, shipmentId: string): Promise<ShipmentEventRow[]> {
  return db.all<ShipmentEventRow>('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at ASC', [
    shipmentId,
  ]);
}

/**
 * Book a parcel for a confirmed order and move it to `shipped`.
 *
 * Refuses to book twice: an existing live shipment is returned rather than a
 * second AWB being minted, because two AWBs for one order means one of them is
 * an unbilled ghost that the courier will still try to collect.
 */
export async function createShipmentForOrder(
  ctx: AppContext,
  orderId: string,
  opts: { courierId?: string | null; actorId: string } = { actorId: 'system' },
): Promise<ShipmentRow> {
  const order = await getOrderById(ctx.db, orderId);
  if (!order) throw notFound('We could not find that order.');

  const existing = await getShipmentForOrder(ctx.db, orderId);
  if (existing) {
    // A parcel is already booked, so do NOT mint a second AWB — two AWBs for one
    // order means one is a ghost the courier still tries to collect. But the
    // order may have been left behind if the earlier attempt failed after the
    // insert, so reconcile its status before returning.
    if (existing.awb_code && order.status !== 'shipped') {
      await transitionOrder(ctx.db, {
        orderId,
        to: 'shipped',
        message: `Shipped with ${existing.courier_name ?? 'our delivery partner'}.`,
        data: { awb: existing.awb_code },
        actorType: 'system',
        actorId: opts.actorId,
      }).catch(() => {
        // Already past `shipped` (delivered, returned). Nothing to reconcile.
      });
    }
    return existing;
  }

  if (!['confirmed', 'processing', 'packed'].includes(order.status)) {
    throw conflict(`An order that is ${order.status.replace('_', ' ')} cannot be shipped.`);
  }
  if (order.payment_method === 'prepaid' && order.payment_status !== 'paid') {
    throw conflict('That order has not been paid for yet.');
  }

  const settings = await ctx.settings();
  const items = await ctx.db.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  if (items.length === 0) throw badRequest('That order has no items to ship.');

  const shippingAddress = parseJson<AddressSnapshot>(order.shipping_address_json, {
    full_name: order.customer_name,
    phone: order.phone,
    line1: '',
    city: '',
    state: '',
    pincode: '',
    country: 'IN',
  });
  const billingAddress = parseJson<AddressSnapshot>(order.billing_address_json, shippingAddress);

  let result;
  try {
    result = await ctx.shipping.createShipment({
      orderId: order.id,
      orderNumber: order.order_number,
      placedAt: order.placed_at,
      pickupLocationName: settings.originCity,
      shippingAddress: { ...shippingAddress, email: shippingAddress.email ?? order.email },
      billingAddress: { ...billingAddress, email: billingAddress.email ?? order.email },
      items: items.map((i) => ({
        name: `${i.product_name} ${i.variant_name}`,
        sku: i.sku,
        quantity: i.qty,
        unitPricePaise: i.unit_price_paise,
        discountPaise: i.discount_paise,
        taxPaise: i.tax_paise,
        hsnCode: i.hsn_code,
      })),
      subtotalPaise: order.subtotal_paise,
      shippingChargePaise: order.shipping_paise,
      discountPaise: order.discount_paise,
      totalPaise: order.total_paise,
      // Only an unpaid COD order has money to collect at the door. A COD order
      // that was somehow already settled must not be collected on twice.
      codAmountPaise: order.payment_method === 'cod' && order.payment_status !== 'paid' ? order.total_paise : 0,
      package: {
        weightGrams: order.total_weight_grams || settings.packagingWeightGrams,
        lengthCm: settings.parcelDimensionsCm.length,
        breadthCm: settings.parcelDimensionsCm.breadth,
        heightCm: settings.parcelDimensionsCm.height,
      },
      courierId: opts.courierId ?? null,
    });
  } catch (err) {
    log.error('shipments.create_failed', { orderId, provider: ctx.shipping.name, error: errMessage(err) });
    throw providerError('The courier could not book that parcel. Nothing was charged; please try again.', err);
  }

  const now = Date.now();
  const shipmentId = newId('shp');
  const zone = zoneForPincode(shippingAddress.pincode);

  await ctx.db.batch([
    ctx.db.stmt(
      `INSERT INTO shipments (id, order_id, provider, provider_order_id, provider_shipment_id, awb_code,
                              courier_name, status, label_url, tracking_url, weight_grams, dimensions_json,
                              charges_paise, shipped_at, estimated_delivery_at, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shipmentId,
        orderId,
        ctx.shipping.name,
        result.providerOrderId,
        result.providerShipmentId,
        result.awbCode,
        result.courierName,
        result.labelUrl,
        result.trackingUrl,
        order.total_weight_grams,
        JSON.stringify(settings.parcelDimensionsCm),
        result.chargesPaise,
        now,
        result.estimatedDeliveryAt ?? now + ZONE_ETD_DAYS[zone] * 24 * 60 * 60 * 1000,
        JSON.stringify(result.raw ?? {}).slice(0, 4000),
        now,
        now,
      ],
    ),
    ctx.db.stmt(
      `INSERT INTO shipment_events (id, shipment_id, order_id, status, description, location, occurred_at,
                                    provider_event_id, raw_json, created_at)
       VALUES (?, ?, ?, 'created', 'Shipment booked with the courier.', ?, ?, ?, '{}', ?)`,
      [
        newId('sev'),
        shipmentId,
        orderId,
        `${settings.originCity}, ${settings.originState}`,
        now,
        `${result.providerShipmentId}:created`,
        now,
      ],
    ),
    orderEventStatement(ctx.db, {
      orderId,
      type: 'shipment.created',
      message: result.awbCode
        ? `Parcel booked with ${result.courierName ?? 'the courier'} (AWB ${result.awbCode}).`
        : 'Parcel booked with the courier. Waiting for a tracking number.',
      data: { shipmentId, awb: result.awbCode, courier: result.courierName },
      actorType: 'system',
      actorId: opts.actorId,
    }),
  ]);

  const shipment = (await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipmentId])) as ShipmentRow;

  // An AWB is what makes "shipped" meaningful to a customer. Without one the
  // order stays `packed` until the courier assigns it.
  if (result.awbCode) {
    await transitionOrder(ctx.db, {
      orderId,
      to: 'shipped',
      message: `Shipped with ${result.courierName ?? 'our delivery partner'}.`,
      data: { awb: result.awbCode },
      actorType: 'system',
      actorId: opts.actorId,
    });
    await onOrderShipped(ctx, orderId, shipment);
  } else {
    await transitionOrder(ctx.db, {
      orderId,
      to: 'packed',
      message: 'Packed and waiting for courier pickup.',
      actorType: 'system',
      actorId: opts.actorId,
    });
  }

  log.info('shipments.created', { orderId, shipmentId, awb: result.awbCode, provider: ctx.shipping.name });
  return shipment;
}

export async function cancelShipment(ctx: AppContext, shipmentId: string, actorId: string): Promise<void> {
  const shipment = await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipmentId]);
  if (!shipment) throw notFound('We could not find that shipment.');
  if (shipment.status === 'delivered') throw conflict('That parcel has already been delivered.');

  try {
    await ctx.shipping.cancelShipment(shipment.provider_order_id ?? '', shipment.provider_shipment_id ?? '');
  } catch (err) {
    log.warn('shipments.cancel_provider_failed', { shipmentId, error: errMessage(err) });
    throw providerError('The courier refused that cancellation. Please cancel it in their dashboard.', err);
  }

  await ctx.db.batch([
    ctx.db.stmt("UPDATE shipments SET status = 'cancelled', updated_at = ? WHERE id = ?", [Date.now(), shipmentId]),
    orderEventStatement(ctx.db, {
      orderId: shipment.order_id,
      type: 'shipment.cancelled',
      message: 'Courier booking cancelled.',
      actorType: 'admin',
      actorId,
    }),
  ]);
}

/** Refresh tracking from the courier and fold any new scans in. */
export async function refreshTracking(ctx: AppContext, shipmentId: string): Promise<ShipmentRow> {
  const shipment = await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipmentId]);
  if (!shipment) throw notFound('We could not find that shipment.');

  const tracking = await ctx.shipping.track({
    awbCode: shipment.awb_code,
    providerShipmentId: shipment.provider_shipment_id,
  });

  for (const event of tracking.events) {
    await ingestTrackingEvent(ctx, shipment, event);
  }

  return (await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipmentId])) as ShipmentRow;
}

/**
 * Which order status a parcel state implies. `null` means the scan is
 * informational and should not move the order.
 */
const SHIPMENT_TO_ORDER: Partial<Record<TrackingStatus, OrderRow['status']>> = {
  picked_up: 'shipped',
  in_transit: 'shipped',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  rto_delivered: 'returned',
};

/**
 * Record one scan and let it move the order.
 *
 * Insert-first with a UNIQUE constraint is the dedupe: a courier that re-sends
 * the same scan produces a constraint violation, which is caught and treated as
 * "already seen", so the customer does not get a second "out for delivery" mail.
 */
export async function ingestTrackingEvent(
  ctx: AppContext,
  shipment: ShipmentRow,
  event: TrackingEvent,
): Promise<{ isNew: boolean }> {
  const now = Date.now();
  const providerEventId = event.providerEventId ?? `${event.status}:${event.occurredAt}`;

  try {
    await ctx.db.run(
      `INSERT INTO shipment_events (id, shipment_id, order_id, status, description, location, occurred_at,
                                    provider_event_id, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('sev'),
        shipment.id,
        shipment.order_id,
        event.status,
        event.description.slice(0, 500),
        event.location,
        event.occurredAt,
        providerEventId,
        JSON.stringify(event.raw ?? {}).slice(0, 2000),
        now,
      ],
    );
  } catch (err) {
    const message = errMessage(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) return { isNew: false };
    throw err;
  }

  const sets = ['status = ?', 'updated_at = ?'];
  const params: (string | number | null)[] = [event.status, now];
  if (event.status === 'delivered') {
    sets.push('delivered_at = COALESCE(delivered_at, ?)');
    params.push(event.occurredAt);
  }
  if (event.status === 'picked_up') {
    sets.push('shipped_at = COALESCE(shipped_at, ?)');
    params.push(event.occurredAt);
  }
  params.push(shipment.id);
  await ctx.db.run(`UPDATE shipments SET ${sets.join(', ')} WHERE id = ?`, params);

  const targetStatus = SHIPMENT_TO_ORDER[event.status];
  if (targetStatus) {
    try {
      await transitionOrder(ctx.db, {
        orderId: shipment.order_id,
        to: targetStatus,
        message: event.description || `Parcel update: ${event.status.replace(/_/g, ' ')}.`,
        data: { location: event.location, awb: shipment.awb_code },
        actorType: 'provider',
      });

      const fresh = (await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [
        shipment.id,
      ])) as ShipmentRow;
      if (targetStatus === 'out_for_delivery') await onOutForDelivery(ctx, shipment.order_id, fresh);
      if (targetStatus === 'delivered') await onOrderDelivered(ctx, shipment.order_id);
      if (targetStatus === 'shipped' && !shipment.shipped_at) await onOrderShipped(ctx, shipment.order_id, fresh);
    } catch (err) {
      // An out-of-order scan (delivered arriving before out-for-delivery) is
      // refused by the state machine. That is correct behaviour, not an error
      // worth failing the webhook over — the scan is still recorded above.
      log.info('shipments.transition_skipped', {
        orderId: shipment.order_id,
        to: targetStatus,
        reason: errMessage(err),
      });
    }
  }

  return { isNew: true };
}

/** Handle a courier callback that has already had its signature verified. */
export async function handleShipmentWebhook(
  ctx: AppContext,
  event: ShipmentWebhookEvent,
): Promise<{ outcome: 'processed' | 'duplicate' | 'ignored'; orderId: string | null }> {
  const webhookId = newId('whk');
  const now = Date.now();

  try {
    await ctx.db.run(
      `INSERT INTO webhook_events (id, source, provider, event_id, event_type, status, signature_valid,
                                   payload_json, attempts, received_at)
       VALUES (?, 'shipping', ?, ?, ?, 'received', 1, ?, 1, ?)`,
      [webhookId, ctx.shipping.name, event.eventId, event.status, JSON.stringify(event.raw).slice(0, 20000), now],
    );
  } catch (err) {
    const message = errMessage(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return { outcome: 'duplicate', orderId: null };
    }
    throw err;
  }

  const shipment = await findShipment(ctx.db, event);
  if (!shipment) {
    log.warn('shipments.webhook_unmatched', { awb: event.awbCode, reference: event.orderReference });
    await ctx.db.run("UPDATE webhook_events SET status = 'ignored', processed_at = ? WHERE id = ?", [
      Date.now(),
      webhookId,
    ]);
    return { outcome: 'ignored', orderId: null };
  }

  await ingestTrackingEvent(ctx, shipment, {
    status: event.status,
    description: event.description,
    location: event.location,
    occurredAt: event.occurredAt,
    providerEventId: event.eventId,
    raw: event.raw,
  });

  await ctx.db.run("UPDATE webhook_events SET status = 'processed', order_id = ?, processed_at = ? WHERE id = ?", [
    shipment.order_id,
    Date.now(),
    webhookId,
  ]);

  return { outcome: 'processed', orderId: shipment.order_id };
}

async function findShipment(db: Db, event: ShipmentWebhookEvent): Promise<ShipmentRow | null> {
  if (event.awbCode) {
    const byAwb = await db.first<ShipmentRow>('SELECT * FROM shipments WHERE awb_code = ? LIMIT 1', [event.awbCode]);
    if (byAwb) return byAwb;
  }
  if (event.providerShipmentId) {
    const byId = await db.first<ShipmentRow>('SELECT * FROM shipments WHERE provider_shipment_id = ? LIMIT 1', [
      event.providerShipmentId,
    ]);
    if (byId) return byId;
  }
  if (event.orderReference) {
    // Couriers echo OUR order number, not our internal id.
    const order = await db.first<{ id: string }>('SELECT id FROM orders WHERE order_number = ?', [
      event.orderReference,
    ]);
    if (order) return getShipmentForOrder(db, order.id);
  }
  return null;
}
