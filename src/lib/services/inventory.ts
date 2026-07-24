/**
 * Stock reservations.
 *
 * The invariant is `on_hand - reserved >= 0` at all times, and the money path
 * depends on it: two customers must not both be sold the last 500 g jar.
 *
 * D1 gives atomic batches but no interactive transactions and no row locks, so
 * the reservation is a *conditional* UPDATE — `SET reserved = reserved + n WHERE
 * on_hand - reserved >= n`. A conditional UPDATE that matches nothing is not an
 * error to SQLite, it just changes 0 rows, and the rest of the batch still
 * commits. That is why every multi-line reservation checks the per-statement
 * change counts and compensates: whatever was reserved gets released again
 * before the caller sees the failure.
 *
 * Lifecycle of a unit of stock:
 *   available → reserved   (order created, awaiting payment)   reserveStock
 *   reserved  → sold       (payment confirmed)                 commitReservation
 *   reserved  → available  (cancelled / expired / failed)      releaseReservation
 *   sold      → available  (return / restock)                  adjustStock
 */

import type { Db } from '../db/client';
import type { InventoryRow } from '../db/types';
import { outOfStock } from '../errors';
import { newId } from '../ids';
import { log } from '../log';

export interface StockLine {
  variantId: string;
  qty: number;
}

export interface StockShortfall {
  variantId: string;
  requested: number;
  available: number;
  name?: string;
}

/**
 * Check availability without changing anything. Used to render the cart and to
 * give a precise error before attempting the reservation.
 */
export async function checkAvailability(db: Db, lines: StockLine[]): Promise<StockShortfall[]> {
  if (lines.length === 0) return [];

  const ids = lines.map((l) => l.variantId);
  const rows = await db.all<InventoryRow & { variant_name: string; product_name: string }>(
    `SELECT i.*, v.name AS variant_name, p.name AS product_name
       FROM inventory i
       JOIN product_variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE i.variant_id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.variant_id, r]));

  const shortfalls: StockShortfall[] = [];
  for (const line of lines) {
    const row = byId.get(line.variantId);
    // No inventory row means the variant is not stock-tracked (made to order).
    if (!row || row.track === 0) continue;
    const available = Math.max(0, row.on_hand - row.reserved);
    if (available < line.qty) {
      shortfalls.push({
        variantId: line.variantId,
        requested: line.qty,
        available,
        name: `${row.product_name} ${row.variant_name}`,
      });
    }
  }
  return shortfalls;
}

/**
 * Hold stock for an order. Throws `outOfStock` (with the offending lines in
 * `details`) if any line cannot be satisfied, having released anything it
 * managed to reserve first.
 */
export async function reserveStock(db: Db, lines: StockLine[], orderId: string): Promise<void> {
  const merged = mergeLines(lines);
  if (merged.length === 0) return;

  // Fast path: a plain read gives a good error message for the overwhelmingly
  // common "it sold out five minutes ago" case without touching any rows.
  const preflight = await checkAvailability(db, merged);
  if (preflight.length > 0) {
    throw outOfStock(stockMessage(preflight), { shortfalls: preflight });
  }

  const now = Date.now();
  const statements = merged.map((line) =>
    db.stmt(
      `UPDATE inventory
          SET reserved = reserved + ?, updated_at = ?
        WHERE variant_id = ?
          AND (track = 0 OR on_hand - reserved >= ?)`,
      [line.qty, now, line.variantId, line.qty],
    ),
  );

  const changes = await db.batchChanges(statements);
  const failedIndexes = changes.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);

  if (failedIndexes.length === 0) {
    log.info('inventory.reserved', { orderId, lines: merged.length });
    return;
  }

  // Someone else took the stock between the preflight read and the update.
  // Give back whatever this call did manage to hold.
  const succeeded = merged.filter((_, i) => changes[i] > 0);
  if (succeeded.length > 0) {
    await db.batch(
      succeeded.map((line) =>
        db.stmt('UPDATE inventory SET reserved = MAX(0, reserved - ?), updated_at = ? WHERE variant_id = ?', [
          line.qty,
          now,
          line.variantId,
        ]),
      ),
    );
  }

  const shortfalls = await checkAvailability(
    db,
    failedIndexes.map((i) => merged[i]),
  );
  const detail: StockShortfall[] =
    shortfalls.length > 0
      ? shortfalls
      : failedIndexes.map((i) => ({ variantId: merged[i].variantId, requested: merged[i].qty, available: 0 }));

  log.warn('inventory.reserve_lost_race', { orderId, failed: detail.length });
  throw outOfStock(stockMessage(detail), { shortfalls: detail });
}

/** Give reserved stock back — cancellation, payment failure, reservation expiry. */
export async function releaseReservation(db: Db, lines: StockLine[], orderId: string): Promise<void> {
  const merged = mergeLines(lines);
  if (merged.length === 0) return;
  const now = Date.now();

  await db.batch(
    merged.map((line) =>
      // MAX(0, …) so a double release (webhook retry after a manual cancel)
      // cannot drive `reserved` negative and silently inflate availability.
      db.stmt('UPDATE inventory SET reserved = MAX(0, reserved - ?), updated_at = ? WHERE variant_id = ?', [
        line.qty,
        now,
        line.variantId,
      ]),
    ),
  );
  log.info('inventory.released', { orderId, lines: merged.length });
}

/**
 * Turn a reservation into a sale: stock leaves the shelf. Writes a ledger row
 * per line so the admin stock history explains every movement.
 */
export async function commitReservation(db: Db, lines: StockLine[], orderId: string): Promise<void> {
  const merged = mergeLines(lines);
  if (merged.length === 0) return;
  const now = Date.now();

  const statements = merged.flatMap((line) => [
    db.stmt(
      `UPDATE inventory
          SET on_hand = MAX(0, on_hand - ?), reserved = MAX(0, reserved - ?), updated_at = ?
        WHERE variant_id = ?`,
      [line.qty, line.qty, now, line.variantId],
    ),
    db.stmt(
      `INSERT INTO inventory_ledger (id, variant_id, delta, reason, ref_type, ref_id, note, actor_id, created_at)
       VALUES (?, ?, ?, 'sale', 'order', ?, NULL, 'system', ?)`,
      [newId('inv'), line.variantId, -line.qty, orderId, now],
    ),
  ]);

  await db.batch(statements);
  log.info('inventory.committed', { orderId, lines: merged.length });
}

/** Manual stock movement: restock, spoilage, correction, customer return. */
export async function adjustStock(
  db: Db,
  variantId: string,
  delta: number,
  reason: string,
  actorId: string,
  note?: string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.stmt(
      `INSERT INTO inventory (variant_id, on_hand, reserved, reorder_level, track, updated_at)
       VALUES (?, MAX(0, ?), 0, 6, 1, ?)
       ON CONFLICT (variant_id) DO UPDATE SET on_hand = MAX(0, inventory.on_hand + ?), updated_at = ?`,
      [variantId, delta, now, delta, now],
    ),
    db.stmt(
      `INSERT INTO inventory_ledger (id, variant_id, delta, reason, ref_type, ref_id, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, 'manual', NULL, ?, ?, ?)`,
      [newId('inv'), variantId, delta, reason, note ?? null, actorId, now],
    ),
  ]);
  log.info('inventory.adjusted', { variantId, delta, reason, actorId });
}

/** Variants at or below their reorder level — drives the low-stock alert. */
export async function lowStockVariants(db: Db): Promise<
  { variantId: string; sku: string; name: string; productName: string; available: number; reorderLevel: number }[]
> {
  const rows = await db.all<{
    variant_id: string;
    sku: string;
    name: string;
    product_name: string;
    available: number;
    reorder_level: number;
  }>(
    `SELECT i.variant_id, v.sku, v.name, p.name AS product_name,
            (i.on_hand - i.reserved) AS available, i.reorder_level
       FROM inventory i
       JOIN product_variants v ON v.id = i.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE i.track = 1 AND (i.on_hand - i.reserved) <= i.reorder_level
        AND v.status = 'active'
      ORDER BY available ASC`,
  );
  return rows.map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    name: r.name,
    productName: r.product_name,
    available: Math.max(0, r.available),
    reorderLevel: r.reorder_level,
  }));
}

/** Collapse duplicate variant lines so a cart with two rows of the same SKU reserves once. */
function mergeLines(lines: StockLine[]): StockLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.qty <= 0) continue;
    totals.set(line.variantId, (totals.get(line.variantId) ?? 0) + line.qty);
  }
  return [...totals].map(([variantId, qty]) => ({ variantId, qty }));
}

function stockMessage(shortfalls: StockShortfall[]): string {
  const first = shortfalls[0];
  const label = first.name ?? 'One of the items in your cart';
  if (shortfalls.length === 1) {
    return first.available === 0
      ? `${label} just sold out. Please remove it to continue.`
      : `Only ${first.available} left of ${label}. Please reduce the quantity to continue.`;
  }
  return `${shortfalls.length} items in your cart are no longer available in the quantity you chose. Please review your cart.`;
}
