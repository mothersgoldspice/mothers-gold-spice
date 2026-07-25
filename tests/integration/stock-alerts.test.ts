/**
 * Back-in-stock notifications.
 *
 * The product page has offered "tell me when it is back" since launch, and the
 * email template shipped with it, but for a while nothing connected the two — a
 * customer typed their address and was never written to. These tests exist so
 * that gap cannot silently reopen: the promise is made in the UI, so something
 * has to prove it is kept.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  SEED,
  createContext,
  db,
  flushWaitUntil,
  freshDatabase,
} from '../setup';
import { adjustStock } from '../../src/lib/services/inventory';
import { notifyBackInStock, requestAlert, waitingSummary } from '../../src/lib/services/stock-alerts';
import type { EmailOutboxRow } from '../../src/lib/db/types';

/** Drive a variant's shelf count to exactly `to`, without going through alerts. */
async function setOnHand(variantId: string, to: number): Promise<void> {
  await db.run('UPDATE inventory SET on_hand = ?, reserved = 0, updated_at = ? WHERE variant_id = ?', [
    to,
    Date.now(),
    variantId,
  ]);
}

async function queuedBackInStock(): Promise<EmailOutboxRow[]> {
  return db.all<EmailOutboxRow>("SELECT * FROM email_outbox WHERE template = 'catalog_back_in_stock'");
}

describe('back-in-stock alerts', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('writes one alert per address and ignores a repeat', async () => {
    const ctx = createContext();
    await requestAlert(ctx, SEED.pickle.small.id, 'Asha@Example.com');
    await requestAlert(ctx, SEED.pickle.small.id, 'asha@example.com');

    const rows = await db.all<{ email: string }>('SELECT email FROM stock_alerts WHERE variant_id = ?', [
      SEED.pickle.small.id,
    ]);
    expect(rows).toHaveLength(1);
    // Normalised on the way in, so the same person in different case is one row.
    expect(rows[0].email).toBe('asha@example.com');
  });

  it('says nothing while the shelf is still empty', async () => {
    const ctx = createContext();
    await setOnHand(SEED.pickle.small.id, 0);
    await requestAlert(ctx, SEED.pickle.small.id, 'asha@example.com');

    const { notified } = await notifyBackInStock(ctx, [SEED.pickle.small.id]);

    expect(notified).toBe(0);
    expect(await queuedBackInStock()).toHaveLength(0);
  });

  it('emails everyone waiting once stock returns, and marks them notified', async () => {
    const ctx = createContext();
    await setOnHand(SEED.pickle.small.id, 0);
    await requestAlert(ctx, SEED.pickle.small.id, 'asha@example.com');
    await requestAlert(ctx, SEED.pickle.small.id, 'ravi@example.com');

    await setOnHand(SEED.pickle.small.id, 6);
    const { notified } = await notifyBackInStock(ctx, [SEED.pickle.small.id]);
    await flushWaitUntil(ctx);

    expect(notified).toBe(2);

    const queued = await queuedBackInStock();
    expect(queued).toHaveLength(2);
    expect(queued.map((e) => e.to_email).sort()).toEqual(['asha@example.com', 'ravi@example.com']);
    // The subject has to name the thing, or it reads as spam.
    expect(queued[0].subject).toContain(SEED.pickle.name);

    const outstanding = await db.scalar<number>(
      'SELECT COUNT(*) FROM stock_alerts WHERE variant_id = ? AND notified_at IS NULL',
      [SEED.pickle.small.id],
    );
    expect(outstanding).toBe(0);
  });

  it('does not tell the same person twice when a second batch lands', async () => {
    const ctx = createContext();
    await setOnHand(SEED.pickle.small.id, 0);
    await requestAlert(ctx, SEED.pickle.small.id, 'asha@example.com');

    await setOnHand(SEED.pickle.small.id, 4);
    await notifyBackInStock(ctx, [SEED.pickle.small.id]);

    // Sells out, then another batch is cooked.
    await setOnHand(SEED.pickle.small.id, 0);
    await setOnHand(SEED.pickle.small.id, 9);
    const second = await notifyBackInStock(ctx, [SEED.pickle.small.id]);

    expect(second.notified).toBe(0);
    expect(await queuedBackInStock()).toHaveLength(1);
  });

  it('is reached by a restock through the inventory service', async () => {
    const ctx = createContext();
    await setOnHand(SEED.pickle.large.id, 0);
    await requestAlert(ctx, SEED.pickle.large.id, 'asha@example.com');

    // The path an admin actually takes.
    await adjustStock(db, SEED.pickle.large.id, 12, 'restock', 'usr_test_admin');
    const { notified } = await notifyBackInStock(ctx, [SEED.pickle.large.id]);
    await flushWaitUntil(ctx);

    expect(notified).toBe(1);
    expect((await queuedBackInStock())[0].to_email).toBe('asha@example.com');
  });

  it('will not promise a variant whose product is not on sale', async () => {
    const ctx = createContext();
    await setOnHand(SEED.pickle.small.id, 0);
    await requestAlert(ctx, SEED.pickle.small.id, 'asha@example.com');

    await db.run("UPDATE products SET status = 'draft' WHERE id = ?", [SEED.pickle.productId]);
    await setOnHand(SEED.pickle.small.id, 5);

    const { notified } = await notifyBackInStock(ctx, [SEED.pickle.small.id]);

    // Stock exists, but nobody can buy it — mailing here sends people to a 404.
    expect(notified).toBe(0);
  });

  it('reports who is waiting, busiest first', async () => {
    const ctx = createContext();
    await setOnHand(SEED.pickle.small.id, 0);
    await setOnHand(SEED.pickle.large.id, 0);
    await requestAlert(ctx, SEED.pickle.small.id, 'a@example.com');
    await requestAlert(ctx, SEED.pickle.small.id, 'b@example.com');
    await requestAlert(ctx, SEED.pickle.large.id, 'c@example.com');

    const summary = await waitingSummary(ctx);

    expect(summary[0].variantId).toBe(SEED.pickle.small.id);
    expect(summary[0].waiting).toBe(2);
    expect(summary.find((s) => s.variantId === SEED.pickle.large.id)?.waiting).toBe(1);
  });
});
