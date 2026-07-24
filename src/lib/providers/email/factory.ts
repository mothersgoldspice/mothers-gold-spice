/**
 * Resolves the active EmailProvider from configuration.
 *
 * The fail-loud rule matters more than the switch: on a deployed environment
 * where mocks are not explicitly permitted, resolving to the mock THROWS rather
 * than quietly swallowing every order confirmation. A store that appears to work
 * while no customer ever receives an email is the worst possible failure mode,
 * so it is made impossible to reach by accident.
 */

import { isDeployedEnv, mocksAllowed, optionalEnv, type Env } from '../../env';
import { log } from '../../log';
import { MockEmailProvider } from './mock';
import { ResendEmailProvider } from './resend';
import type { EmailProvider } from './types';

export function createEmailProvider(env: Env): EmailProvider {
  const configured = optionalEnv(env, 'EMAIL_PROVIDER', 'mock').toLowerCase();

  switch (configured) {
    case 'resend': {
      const key = optionalEnv(env, 'RESEND_API_KEY');
      if (!key) {
        if (isDeployedEnv(env)) {
          log.alert('EMAIL_PROVIDER=resend but RESEND_API_KEY is unset on a deployed environment', {
            alertKey: 'email_provider_misconfigured',
          });
          throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY.');
        }
        log.warn('RESEND_API_KEY unset outside a deployed env — using MockEmailProvider');
        return new MockEmailProvider();
      }
      return new ResendEmailProvider(key);
    }

    case 'mock':
    default: {
      if (!mocksAllowed(env)) {
        log.alert('Mock email provider requested on a deployed environment', {
          alertKey: 'email_provider_mock_on_deployed_env',
          configured,
        });
        throw new Error(
          `Refusing to use MockEmailProvider with APP_ENV=${String(env.APP_ENV)}. ` +
            'No customer would receive an order confirmation. Set EMAIL_PROVIDER=resend with ' +
            'RESEND_API_KEY, or set ALLOW_MOCK_PROVIDERS=true to acknowledge a pre-launch deploy.',
        );
      }
      if (configured !== 'mock') {
        log.warn('Unrecognised EMAIL_PROVIDER — falling back to mock', { configured });
      }
      return new MockEmailProvider(optionalEnv(env, 'MOCK_EMAIL_FAIL_TO') || null);
    }
  }
}
