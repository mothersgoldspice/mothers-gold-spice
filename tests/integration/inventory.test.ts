/**
 * Stock reservations, against a real D1.
 *
 * The whole design rests on a D1 detail: a conditional UPDATE whose WHERE clause
 * fails is not an error, it is a statement that changed zero rows — and the rest
 * of the atomic batch commits anyway. These tests exercise that directly, which
 * is only meaningful because the suite runs on workerd with the real binding.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isAppError } from '../../src/lib/errors';
import {
  adjustStock,
  checkAvailability,
  commitReservation,
  lowStockVariants,
  releaseReservation,
  reserveStock,
} from '../../src/lib/services/inventory';
import { SEED, availableOf, db, freshDatabase, inventoryOf } from '../setup';

const SMALL = SEED.pickle.small.id; // 20 on hand
const LARGE = SEED.pickle.large.id; // 10 on hand
const CHUTNEY = SEED.chutney.jar.id; // 4 on hand
const CATERING = SEED.pickle.catering.id; // no inventory row at all

beforeEach(freshDatabase);

describe('checkAvailability', () => {
  it('reports nothing when every line can be met', async () => {
    expect(await checkAvailability(db, [{ variantId: SMALL, qty: 20 }])).toEqual([]);
    expect(await checkAvailability(db, [])).toEqual([]);
  });

  it('names the item and the quantity actually left', async () => {
    const shortfalls = await checkAvailability(db, [{ variantId: CHUTNEY, qty: 5 }]);
    expect(shortfalls).toEqual([
      { variantId: CHUTNEY, requested: 5, available: 4, name: 'Coriander Chutney 200 g' },
    ]);
  });

  it('treats a variant with no inventory row as made to order', async () => {
    expect(await checkAvailability(db, [{ variantId: CATERING, qty: 99 }])).toEqual([]);
  });

  it('ignores a variant that is explicitly not tracked', async () => {
    await db.run('UPDATE inventory SET track = 0, on_hand = 0 WHERE variant_id = ?', [SMALL]);
    expect(await checkAvailability(db, [{ variantId: SMALL, qty: 500 }])).toEqual([]);
  });
});

describe('reserve → commit', () => {
  it('holds stock without taking it off the shelf, then sells it', async () => {
    await reserveStock(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');

    const held = await inventoryOf(LARGE);
    expect(held).toMatchObject({ on_hand: 10, reserved: 3 });
    expect(await availableOf(LARGE)).toBe(7);

    await commitReservation(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');

    const sold = await inventoryOf(LARGE);
    expect(sold).toMatchObject({ on_hand: 7, reserved: 0 });
    expect(await availableOf(LARGE)).toBe(7);
  });

  it('writes a ledger row per line so the movement is explainable', async () => {
    await reserveStock(db, [{ variantId: LARGE, qty: 2 }], 'ord_test');
    await commitReservation(db, [{ variantId: LARGE, qty: 2 }], 'ord_test');

    const ledger = await db.all<{ variant_id: string; delta: number; reason: string; ref_id: string }>(
      'SELECT variant_id, delta, reason, ref_id FROM inventory_ledger ORDER BY created_at',
    );
    expect(ledger).toEqual([{ variant_id: LARGE, delta: -2, reason: 'sale', ref_id: 'ord_test' }]);
  });

  it('collapses two lines of the same variant into one reservation', async () => {
    await reserveStock(
      db,
      [
        { variantId: LARGE, qty: 2 },
        { variantId: LARGE, qty: 3 },
      ],
      'ord_test',
    );

    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 5 });
  });

  it('lets two orders reserve down to exactly zero available', async () => {
    await reserveStock(db, [{ variantId: CHUTNEY, qty: 3 }], 'ord_a');
    await reserveStock(db, [{ variantId: CHUTNEY, qty: 1 }], 'ord_b');

    expect(await availableOf(CHUTNEY)).toBe(0);
    await expect(reserveStock(db, [{ variantId: CHUTNEY, qty: 1 }], 'ord_c')).rejects.toThrow();
  });

  it('does nothing at all for an empty or zero-quantity request', async () => {
    await reserveStock(db, [], 'ord_test');
    await reserveStock(db, [{ variantId: LARGE, qty: 0 }], 'ord_test');
    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 0 });
  });
});

describe('reserving beyond stock', () => {
  it('throws out_of_stock with the shortfall attached', async () => {
    const error = await reserveStock(db, [{ variantId: CHUTNEY, qty: 5 }], 'ord_test').catch((e: unknown) => e);

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) throw error;
    expect(error.code).toBe('out_of_stock');
    expect(error.status).toBe(409);
    expect(error.message).toBe('Only 4 left of Coriander Chutney 200 g. Please reduce the quantity to continue.');
    expect(error.details).toEqual({
      shortfalls: [{ variantId: CHUTNEY, requested: 5, available: 4, name: 'Coriander Chutney 200 g' }],
    });
  });

  it('leaves the shelf untouched when it refuses', async () => {
    await expect(reserveStock(db, [{ variantId: CHUTNEY, qty: 99 }], 'ord_test')).rejects.toThrow();
    expect(await inventoryOf(CHUTNEY)).toMatchObject({ on_hand: 4, reserved: 0 });
  });

  it('says "sold out" rather than "only 0 left"', async () => {
    await db.run('UPDATE inventory SET on_hand = 0 WHERE variant_id = ?', [CHUTNEY]);
    await expect(reserveStock(db, [{ variantId: CHUTNEY, qty: 1 }], 'ord_test')).rejects.toThrow(
      'Coriander Chutney 200 g just sold out. Please remove it to continue.',
    );
  });

  it('summarises when several lines are short at once', async () => {
    await expect(
      reserveStock(
        db,
        [
          { variantId: CHUTNEY, qty: 9 },
          { variantId: LARGE, qty: 99 },
        ],
        'ord_test',
      ),
    ).rejects.toThrow('2 items in your cart are no longer available in the quantity you chose. Please review your cart.');
  });
});

describe('a partially failing multi-line reservation', () => {
  /**
   * The catering variant has no inventory row: `checkAvailability` skips it
   * (untracked variants are made to order), but the conditional UPDATE finds no
   * row to update and reports zero changes. So the preflight passes, the batch
   * half-succeeds, and the compensation path is the only thing standing between
   * this and a permanently leaked reservation.
   */
  it('gives back everything it managed to hold', async () => {
    const error = await reserveStock(
      db,
      [
        { variantId: LARGE, qty: 4 },
        { variantId: CATERING, qty: 1 },
      ],
      'ord_test',
    ).catch((e: unknown) => e);

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) throw error;
    expect(error.code).toBe('out_of_stock');
    expect(error.details).toEqual({ shortfalls: [{ variantId: CATERING, requested: 1, available: 0 }] });

    // Nothing left reserved: the line that succeeded was rolled back by hand,
    // because D1 committed it happily alongside the one that matched no row.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
    expect(await availableOf(LARGE)).toBe(10);
  });

  it('leaves the shelf exactly as it found it across several good lines', async () => {
    await expect(
      reserveStock(
        db,
        [
          { variantId: SMALL, qty: 2 },
          { variantId: LARGE, qty: 2 },
          { variantId: CATERING, qty: 1 },
        ],
        'ord_test',
      ),
    ).rejects.toThrow();

    expect(await inventoryOf(SMALL)).toMatchObject({ on_hand: 20, reserved: 0 });
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
  });
});

describe('releaseReservation', () => {
  it('hands held stock back', async () => {
    await reserveStock(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');
    await releaseReservation(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');

    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
  });

  it('is idempotent — a webhook retry after a manual cancel changes nothing', async () => {
    await reserveStock(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');

    await releaseReservation(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');
    await releaseReservation(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');
    await releaseReservation(db, [{ variantId: LARGE, qty: 3 }], 'ord_test');

    // Not -6. A negative `reserved` would silently inflate availability and
    // oversell the shelf.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
    expect(await availableOf(LARGE)).toBe(10);
  });

  it('never drives reserved negative, even when asked to release more than is held', async () => {
    await reserveStock(db, [{ variantId: LARGE, qty: 2 }], 'ord_test');
    await releaseReservation(db, [{ variantId: LARGE, qty: 50 }], 'ord_test');

    const row = await inventoryOf(LARGE);
    expect(row?.reserved).toBe(0);
    expect(row?.reserved).toBeGreaterThanOrEqual(0);
    expect(await availableOf(LARGE)).toBe(10);
  });

  it('releases only what the caller asked for', async () => {
    await reserveStock(db, [{ variantId: LARGE, qty: 5 }], 'ord_a');
    await releaseReservation(db, [{ variantId: LARGE, qty: 2 }], 'ord_a');

    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 3 });
  });
});

describe('commitReservation', () => {
  it('never drives on_hand negative on a double commit', async () => {
    await reserveStock(db, [{ variantId: CHUTNEY, qty: 4 }], 'ord_test');
    await commitReservation(db, [{ variantId: CHUTNEY, qty: 4 }], 'ord_test');
    await commitReservation(db, [{ variantId: CHUTNEY, qty: 4 }], 'ord_test');

    const row = await inventoryOf(CHUTNEY);
    expect(row?.on_hand).toBe(0);
    expect(row?.reserved).toBe(0);
  });
});

describe('adjustStock', () => {
  it('restocks and records who did it', async () => {
    await adjustStock(db, CHUTNEY, 12, 'restock', 'usr_admin', 'New batch out of the kitchen');

    expect(await inventoryOf(CHUTNEY)).toMatchObject({ on_hand: 16 });
    const ledger = await db.first<{ delta: number; reason: string; actor_id: string; note: string }>(
      'SELECT delta, reason, actor_id, note FROM inventory_ledger WHERE variant_id = ?',
      [CHUTNEY],
    );
    expect(ledger).toEqual({
      delta: 12,
      reason: 'restock',
      actor_id: 'usr_admin',
      note: 'New batch out of the kitchen',
    });
  });

  it('creates the inventory row for a variant that never had one', async () => {
    await adjustStock(db, CATERING, 5, 'restock', 'usr_admin');
    expect(await inventoryOf(CATERING)).toMatchObject({ on_hand: 5, reserved: 0, track: 1 });
  });

  it('clamps a negative correction at zero', async () => {
    await adjustStock(db, CHUTNEY, -99, 'spoilage', 'usr_admin');
    expect(await inventoryOf(CHUTNEY)).toMatchObject({ on_hand: 0 });
  });
});

describe('lowStockVariants', () => {
  it('lists what is at or below its reorder level, scarcest first', async () => {
    const low = await lowStockVariants(db);

    // Seeded: chutney has 4 against a reorder level of 6; the jars have 20 and 10.
    expect(low.map((v) => v.variantId)).toEqual([SEED.chutney.jar.id]);
    expect(low[0]).toMatchObject({ available: 4, reorderLevel: 6, productName: 'Coriander Chutney' });
  });

  it('counts reserved units as gone', async () => {
    await reserveStock(db, [{ variantId: SEED.pickle.large.id, qty: 5 }], 'ord_test');
    const low = await lowStockVariants(db);
    expect(low.map((v) => v.variantId)).toEqual([SEED.chutney.jar.id, SEED.pickle.large.id]);
  });
});
