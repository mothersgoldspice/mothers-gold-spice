/**
 * Resolves the active ShipmentProvider from configuration.
 *
 * Same fail-loud contract as the payment factory: a mock courier on a live store
 * would print AWBs that no one picks up, so it only resolves where mocks are
 * explicitly permitted.
 */

import type { Db } from '../../db/client';
import { isDeployedEnv, mocksAllowed, optionalEnv, sessionSecret, type Env } from '../../env';
import { log } from '../../log';
import { ORIGIN_PINCODE } from '../../shipping-zones';
import type { MockStore } from '../mock-store';
import { MockShipmentProvider } from './mock';
import { ShiprocketProvider, type TokenCache } from './shiprocket';
import type { ShipmentProvider } from './types';

/**
 * Shiprocket's bearer token lives ~10 days and a Worker keeps nothing between
 * requests, so it is cached in `settings` rather than in module scope.
 */
class SettingsTokenCache implements TokenCache {
  private static readonly KEY = 'shiprocket_token';

  constructor(private readonly db: Db) {}

  async get(): Promise<{ token: string; expiresAt: number } | null> {
    const row = await this.db.first<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [
      SettingsTokenCache.KEY,
    ]);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value_json) as { token?: string; expiresAt?: number };
      if (!parsed.token || !parsed.expiresAt) return null;
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    } catch {
      return null;
    }
  }

  async set(token: string, expiresAt: number): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, 'system')
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [SettingsTokenCache.KEY, JSON.stringify({ token, expiresAt }), Date.now()],
    );
  }
}

export function createShipmentProvider(env: Env, db: Db, mockStore: MockStore): ShipmentProvider {
  const configured = optionalEnv(env, 'SHIPPING_PROVIDER', 'mock').toLowerCase();

  switch (configured) {
    case 'shiprocket':
      return new ShiprocketProvider(
        {
          email: optionalEnv(env, 'SHIPROCKET_EMAIL'),
          password: optionalEnv(env, 'SHIPROCKET_PASSWORD'),
          pickupLocation: optionalEnv(env, 'SHIPROCKET_PICKUP_LOCATION', 'Primary'),
          webhookToken: optionalEnv(env, 'SHIPROCKET_WEBHOOK_TOKEN'),
          originPincode: optionalEnv(env, 'ORIGIN_PINCODE', ORIGIN_PINCODE),
        },
        new SettingsTokenCache(db),
      );

    case 'mock':
    default: {
      if (!mocksAllowed(env)) {
        log.alert('Mock shipping provider requested on a deployed environment', {
          alertKey: 'shipping_provider_mock_on_deployed_env',
          configured,
        });
        throw new Error(
          `Refusing to use MockShipmentProvider with APP_ENV=${String(env.APP_ENV)}. ` +
            'Orders would be marked shipped with AWBs no courier has. Set SHIPPING_PROVIDER=shiprocket ' +
            'with credentials, or ALLOW_MOCK_PROVIDERS=true for a pre-launch deploy.',
        );
      }
      if (configured !== 'mock') {
        log.warn('Unrecognised SHIPPING_PROVIDER — falling back to mock', { configured });
      }
      if (isDeployedEnv(env)) {
        log.warn('shipping.provider.mock_on_deployed_env', {
          detail: 'ALLOW_MOCK_PROVIDERS=true — parcels are simulated, not booked.',
        });
      }
      return new MockShipmentProvider(mockStore, sessionSecret(env));
    }
  }
}
