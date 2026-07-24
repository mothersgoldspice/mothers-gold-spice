/**
 * Resolves the active PaymentProvider from configuration.
 *
 * The guard is the important part. A stub gateway on a live storefront does not
 * fail visibly — it mints fake "paid" orders, ships real jars, and collects
 * nothing. So on a deployed environment, resolving to the mock without an
 * explicit ALLOW_MOCK_PROVIDERS=true throws at construction, which surfaces as a
 * 500 on the first checkout rather than as a month of free pickle.
 */

import { isDeployedEnv, mocksAllowed, optionalEnv, sessionSecret, siteUrl, type Env } from '../../env';
import { log } from '../../log';
import type { MockStore } from '../mock-store';
import { MockPaymentProvider } from './mock';
import { PaddlePaymentProvider } from './paddle';
import { RazorpayPaymentProvider } from './razorpay';
import type { PaymentProvider } from './types';

export function createPaymentProvider(env: Env, mockStore: MockStore): PaymentProvider {
  const configured = optionalEnv(env, 'PAYMENT_PROVIDER', 'mock').toLowerCase();

  switch (configured) {
    case 'paddle':
      return new PaddlePaymentProvider({
        apiKey: optionalEnv(env, 'PADDLE_API_KEY'),
        webhookSecret: optionalEnv(env, 'PADDLE_WEBHOOK_SECRET'),
        environment: optionalEnv(env, 'PADDLE_ENVIRONMENT', 'sandbox') === 'production' ? 'production' : 'sandbox',
        productId: optionalEnv(env, 'PADDLE_PRODUCT_ID') || null,
      });

    case 'razorpay':
      return new RazorpayPaymentProvider({
        keyId: optionalEnv(env, 'RAZORPAY_KEY_ID'),
        keySecret: optionalEnv(env, 'RAZORPAY_KEY_SECRET'),
        webhookSecret: optionalEnv(env, 'RAZORPAY_WEBHOOK_SECRET'),
      });

    case 'mock':
    default: {
      if (!mocksAllowed(env)) {
        log.alert('Mock payment provider requested on a deployed environment', {
          alertKey: 'payment_provider_mock_on_deployed_env',
          configured,
          appEnv: String(env.APP_ENV),
        });
        throw new Error(
          `Refusing to use MockPaymentProvider with APP_ENV=${String(env.APP_ENV)}. ` +
            'It would mark orders paid without collecting money. Set PAYMENT_PROVIDER=razorpay|paddle ' +
            'with the matching credentials, or ALLOW_MOCK_PROVIDERS=true for a pre-launch deploy.',
        );
      }
      if (configured !== 'mock') {
        log.warn('Unrecognised PAYMENT_PROVIDER — falling back to mock', { configured });
      }
      if (isDeployedEnv(env)) {
        log.warn('payment.provider.mock_on_deployed_env', {
          detail: 'ALLOW_MOCK_PROVIDERS=true — no real money is being collected.',
        });
      }
      return new MockPaymentProvider(mockStore, sessionSecret(env), siteUrl(env));
    }
  }
}
