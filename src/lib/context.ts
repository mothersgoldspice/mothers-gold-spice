/**
 * Per-request application context.
 *
 * Everything a route or service needs — database, providers, settings, the
 * signed-in user — is assembled once by the middleware and passed down. There
 * are no module-level singletons, because a Worker isolate is shared across
 * requests for *different* environments and caching a provider built from one
 * request's env would leak configuration between them.
 *
 * Providers are constructed lazily: a page that only lists products should not
 * pay to build a payment client, and a misconfigured shipping provider should
 * not stop the storefront from rendering.
 */

import { Db } from './db/client';
import type { Env } from './env';
import { D1MockStore, type MockStore } from './providers/mock-store';
import { createEmailProvider } from './providers/email/factory';
import type { EmailProvider } from './providers/email/types';
import { createPaymentProvider } from './providers/payment/factory';
import type { PaymentProvider } from './providers/payment/types';
import { createShipmentProvider } from './providers/shipping/factory';
import type { ShipmentProvider } from './providers/shipping/types';
import { loadSettings, type StoreSettings } from './settings';
import type { UserRow } from './db/types';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRow['role'];
  emailVerified: boolean;
}

export class AppContext {
  readonly db: Db;
  private readonly mockStore: MockStore;

  private _email?: EmailProvider;
  private _payment?: PaymentProvider;
  private _shipping?: ShipmentProvider;
  private _settings?: StoreSettings;

  /** Signed-in user, or null for anonymous/guest traffic. */
  user: SessionUser | null = null;
  /** Raw session id (hashed form) for the current request, if any. */
  sessionId: string | null = null;
  /** Cart id from the cart cookie, if any. */
  cartId: string | null = null;
  /** Per-request CSRF token, echoed into forms. */
  csrfToken = '';
  readonly requestId: string;

  /**
   * Cloudflare's `waitUntil`. Lets a request return the moment the customer's
   * order is durable while the confirmation email is still being handed to the
   * provider — the alternative is making them watch a spinner for an SMTP round
   * trip that has no bearing on whether the order exists.
   */
  readonly waitUntil: (promise: Promise<unknown>) => void;

  constructor(
    readonly env: Env,
    readonly url: URL,
    readonly clientIp: string,
    requestId: string,
    waitUntil?: (promise: Promise<unknown>) => void,
  ) {
    this.db = new Db(env.DB);
    this.mockStore = new D1MockStore(this.db);
    this.requestId = requestId;
    // Falls back to awaiting nothing when there is no execution context (tests,
    // build-time). The work still runs; it just is not deferred.
    this.waitUntil = waitUntil ?? (() => {});
  }

  get email(): EmailProvider {
    this._email ??= createEmailProvider(this.env);
    return this._email;
  }

  get payment(): PaymentProvider {
    this._payment ??= createPaymentProvider(this.env, this.mockStore);
    return this._payment;
  }

  get shipping(): ShipmentProvider {
    this._shipping ??= createShipmentProvider(this.env, this.db, this.mockStore);
    return this._shipping;
  }

  /** Settings are read once per request and reused. */
  async settings(): Promise<StoreSettings> {
    this._settings ??= await loadSettings(this.db);
    return this._settings;
  }

  /** Invalidate the cached settings after an admin write in the same request. */
  invalidateSettings(): void {
    this._settings = undefined;
  }

  get isAdmin(): boolean {
    return this.user?.role === 'admin' || this.user?.role === 'staff';
  }
}
