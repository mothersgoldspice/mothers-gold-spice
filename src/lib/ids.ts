/**
 * Prefixed, k-sortable identifiers.
 *
 * `ord_01k2m9x7q4_a8f3d1` — 48-bit millisecond timestamp in Crockford base32
 * followed by random suffix. Sorting by id sorts by creation time, which keeps
 * `ORDER BY id` usable as a cheap tiebreaker and makes ids readable in logs.
 */

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

function base32(value: number, length: number): string {
  let out = '';
  let n = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function randomSuffix(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += CROCKFORD[b % 32];
  return out;
}

export type IdPrefix =
  | 'usr'
  | 'ses'
  | 'tok'
  | 'adr'
  | 'prd'
  | 'var'
  | 'inv'
  | 'crt'
  | 'itm'
  | 'ord'
  | 'oit'
  | 'evt'
  | 'pay'
  | 'ref'
  | 'shp'
  | 'sev'
  | 'ntf'
  | 'eml'
  | 'whk'
  | 'aud'
  | 'cpn'
  | 'red'
  | 'rev'
  | 'sub'
  | 'alr';

/** Generate a new prefixed id, e.g. `newId('ord')`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${base32(Date.now(), 10)}${randomSuffix(8)}`;
}

/** URL-safe opaque token (cart cookie, session cookie, email links). */
export function newToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Human-facing order number: `MGS-26-0417`.
 *
 * The sequence is per calendar year and derived from a count, so it is caller's
 * responsibility to pass a monotonically increasing `sequence` (the order repo
 * takes it from a COUNT of the year's orders inside the insert retry loop).
 */
export function formatOrderNumber(sequence: number, at: Date = new Date()): string {
  const yy = String(at.getUTCFullYear()).slice(-2);
  return `MGS-${yy}-${String(sequence).padStart(4, '0')}`;
}
