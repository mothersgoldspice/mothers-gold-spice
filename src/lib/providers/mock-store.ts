/**
 * Persistence for the mock providers' *simulated vendor state*.
 *
 * A real Paddle transaction lives at Paddle; a real Shiprocket AWB lives at
 * Shiprocket. The mocks need an equivalent, and a Worker keeps nothing between
 * requests, so it goes in `mock_provider_state` — a store that belongs to the
 * fake vendor, deliberately separate from the business tables.
 *
 * The mocks are handed this interface rather than a `Db`, so a mock provider
 * still cannot read `orders` or `payments`: it only knows what a vendor would.
 */

import type { Db } from '../db/client';
import { parseJson } from '../db/client';

export interface MockStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(kind: 'payment' | 'shipment', key: string, value: T): Promise<void>;
  list<T>(kind: 'payment' | 'shipment', limit?: number): Promise<{ key: string; value: T }[]>;
}

export class D1MockStore implements MockStore {
  constructor(private readonly db: Db) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.db.first<{ value_json: string }>(
      'SELECT value_json FROM mock_provider_state WHERE key = ?',
      [key],
    );
    return row ? parseJson<T | null>(row.value_json, null) : null;
  }

  async put<T>(kind: 'payment' | 'shipment', key: string, value: T): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO mock_provider_state (key, kind, value_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, kind, JSON.stringify(value), now, now],
    );
  }

  async list<T>(kind: 'payment' | 'shipment', limit = 100): Promise<{ key: string; value: T }[]> {
    const rows = await this.db.all<{ key: string; value_json: string }>(
      'SELECT key, value_json FROM mock_provider_state WHERE kind = ? ORDER BY updated_at DESC LIMIT ?',
      [kind, limit],
    );
    return rows.map((r) => ({ key: r.key, value: parseJson<T>(r.value_json, {} as T) }));
  }
}
