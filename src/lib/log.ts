/**
 * Structured logging for the Worker. One JSON line per event so Cloudflare's
 * Workers Logs / `wrangler tail` stay greppable, with PII masked at the source —
 * a customer's email must never appear whole in a log line.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

/**
 * There is deliberately no module-level "current request id" here.
 *
 * A Worker isolate serves many concurrent requests, so a mutable module variable
 * set by middleware would be clobbered by whichever request ran last — every log
 * line would carry a plausible but wrong id, which is worse than carrying none.
 * Cloudflare's Workers Logs already groups lines by invocation, so correlation
 * is not lost; anything needing an explicit id passes it as a field.
 */
function emit(level: Level, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, f?: LogFields) => emit('debug', m, f),
  info: (m: string, f?: LogFields) => emit('info', m, f),
  warn: (m: string, f?: LogFields) => emit('warn', m, f),
  error: (m: string, f?: LogFields) => emit('error', m, f),
  /** Reserved for money/security paths an operator must notice. */
  alert: (m: string, f?: LogFields) => emit('error', m, { ...f, alert: true }),
};

/** `ravi.kumar@gmail.com` → `ra***@gmail.com`. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

/** `+919845012345` → `+9198****2345`. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length <= 6) return '*'.repeat(phone.length);
  return `${phone.slice(0, 4)}${'*'.repeat(phone.length - 8)}${phone.slice(-4)}`;
}

/** Extract a loggable message from an unknown throwable. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
