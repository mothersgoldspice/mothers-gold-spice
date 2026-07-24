/**
 * Thin typed helpers over the D1 binding.
 *
 * D1 has no interactive transactions — only `batch()`, which runs an array of
 * statements atomically. Anything that must be all-or-nothing (order creation,
 * stock decrement, refund) is therefore expressed as a prepared batch rather
 * than a sequence of awaits. `Db.batch` is the only correct way to write
 * multi-row invariants here; see `guardedBatch` for the conditional-update
 * pattern used for stock.
 */

import { log } from '../log';

export type SqlValue = string | number | null;

export class Db {
  constructor(readonly d1: D1Database) {}

  /** First row, or null. */
  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const stmt = this.d1.prepare(sql).bind(...params);
    return (await stmt.first<T>()) ?? null;
  }

  /** All rows. */
  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const res = await stmt.all<T>();
    if (!res.success) throw new Error(`D1 query failed: ${sql}`);
    return res.results ?? [];
  }

  /** A single scalar (`SELECT COUNT(*) …`). */
  async scalar<T = number>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const row = await this.first<Record<string, T>>(sql, params);
    if (!row) return null;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : null;
  }

  /** INSERT/UPDATE/DELETE. Returns rows written. */
  async run(sql: string, params: SqlValue[] = []): Promise<number> {
    const res = await this.d1
      .prepare(sql)
      .bind(...params)
      .run();
    if (!res.success) throw new Error(`D1 statement failed: ${sql}`);
    return res.meta?.changes ?? 0;
  }

  /** Prepare a statement for inclusion in a batch. */
  stmt(sql: string, params: SqlValue[] = []): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...params);
  }

  /** Atomic multi-statement write. Empty input is a no-op, not an error. */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    if (statements.length === 0) return [];
    return this.d1.batch(statements);
  }

  /**
   * Run conditional UPDATEs and report which ones matched no row.
   *
   * A statement whose WHERE clause encodes an invariant (`… AND on_hand -
   * reserved >= ?`) does not *fail* when the invariant is false — it succeeds
   * having changed 0 rows, and D1's atomic batch happily commits its siblings.
   * So callers get the per-statement change counts back and are responsible for
   * compensating; see `reserveStock` in services/inventory.ts, which reverses
   * the partial reservations it made.
   */
  async batchChanges(statements: D1PreparedStatement[]): Promise<number[]> {
    const results = await this.batch(statements);
    return results.map((r) => r.meta?.changes ?? 0);
  }
}

/** `?, ?, ?` for an IN clause of the given length. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** Parse a `*_json` column, falling back rather than throwing on corrupt rows. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn('Failed to parse JSON column', { sample: raw.slice(0, 80) });
    return fallback;
  }
}

/** SQLite has no booleans; rows store 0/1. */
export const bool = (v: number | null | undefined): boolean => v === 1;
export const toInt = (v: boolean): number => (v ? 1 : 0);
