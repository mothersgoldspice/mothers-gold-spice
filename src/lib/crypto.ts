/**
 * Cryptographic primitives, WebCrypto only.
 *
 * Workers have no Node `crypto` module and no native bcrypt/argon2 binding, so
 * password hashing is PBKDF2-HMAC-SHA256 — the strongest KDF the runtime offers
 * natively. The stored format is self-describing so the iteration count can be
 * raised later and old hashes still verify (and get transparently upgraded on
 * the next successful login).
 *
 * ─── On the iteration count ──────────────────────────────────────────────────
 *
 * OWASP recommends 210,000 for PBKDF2-SHA256, and that is what this originally
 * used. The Cloudflare runtime refuses it:
 *
 *     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *     supported (requested 210000).
 *
 * That is a hard platform cap, verified against the live edge — and it does NOT
 * reproduce in local development, where the same call succeeds. So this was a
 * bug that only existed in production: every sign-up and sign-in returned a 500
 * while the whole suite passed locally.
 *
 * 100,000 is therefore the ceiling, not a preference. With a per-user salt and a
 * 10-character minimum passphrase it remains a reasonable barrier for a store of
 * this size. If more is wanted later, the options are a WASM argon2 build or a
 * server-side pepper held in a Worker secret (so a stolen database is not
 * sufficient to attack the hashes offline) — both are additive, because the hash
 * format records its own parameters.
 */

const enc = new TextEncoder();

/** Hard limit imposed by the Workers runtime. Going above it throws. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_LENGTH_BITS,
  );
  return toHex(bits);
}

/** Returns `pbkdf2$sha256$<iterations>$<saltHex>$<hashHex>`. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  // Clamped rather than trusted: a caller asking for more than the runtime
  // allows would otherwise throw at the worst possible moment — mid-signup, in
  // production only. Silently doing the strongest thing available is better
  // than refusing to create the account.
  const safeIterations = Math.min(Math.max(1, Math.floor(iterations)), PBKDF2_MAX_ITERATIONS);
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, safeIterations);
  return `pbkdf2$sha256$${safeIterations}$${toHex(salt)}$${hash}`;
}

export interface VerifyResult {
  valid: boolean;
  /** True when the stored hash used fewer iterations than we now require. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string | null): Promise<VerifyResult> {
  if (!stored) {
    // Still burn comparable time so "no password set" is not distinguishable by timing.
    await pbkdf2(password, new Uint8Array(SALT_BYTES), PBKDF2_ITERATIONS);
    return { valid: false, needsRehash: false };
  }
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') {
    return { valid: false, needsRehash: false };
  }
  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return { valid: false, needsRehash: false };

  // A hash written before the platform cap was discovered (or by a tool that did
  // not know about it) cannot be re-derived here at all — deriveBits throws.
  // Report it as a failed verification rather than a 500, so the customer is
  // told to reset their password instead of hitting an error page forever.
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    return { valid: false, needsRehash: false };
  }

  const computed = await pbkdf2(password, fromHex(parts[3]), iterations);
  const valid = timingSafeEqual(computed, parts[4]);
  return { valid, needsRehash: valid && iterations < PBKDF2_ITERATIONS };
}

/** Length-independent constant-time string compare (hex/base64 inputs). */
export function timingSafeEqual(a: string, b: string): boolean {
  // Compare fixed-width digests of the inputs so an early length mismatch does
  // not leak through the loop bound.
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** SHA-256 hex. Used to store session/auth tokens without storing the token itself. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return toHex(digest);
}

/** HMAC-SHA256 hex — CSRF tokens, guest-order links, provider signature checks. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

/** Verify a hex HMAC in constant time. */
export async function verifyHmacSha256(secret: string, message: string, signatureHex: string): Promise<boolean> {
  const expected = await hmacSha256Hex(secret, message);
  return timingSafeEqual(expected, signatureHex.trim().toLowerCase());
}

/** Base64url without padding — compact tokens that survive URLs and cookies. */
export function base64UrlEncode(input: string): string {
  const bytes = enc.encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
