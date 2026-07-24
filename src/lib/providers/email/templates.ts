/**
 * Every transactional email the store sends, rendered to subject + text + html.
 *
 * These are pure functions — no Env, no database, no provider, no I/O. A service
 * renders a message, writes the rendered copy into `email_outbox`, and the
 * dispatcher hands that stored copy to whichever adapter is configured. Keeping
 * rendering pure is what lets /admin/emails show exactly what the customer got,
 * and what lets a template change be reviewed by reading one file.
 *
 * The markup is deliberately old-fashioned: nested tables, a fixed 600px column,
 * inline styles only, no <style> block, no webfonts. Gmail strips <style>,
 * Outlook renders through Word, and neither supports flex or grid — anything
 * prettier would arrive broken in the two clients most of our customers use.
 */

import type { AddressSnapshot, PaymentMethod } from '../../db/types';
import type { Env } from '../../env';
import { siteUrl, storeName, supportEmail } from '../../env';
import { formatPaise } from '../../money';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  template: string;
}

/**
 * The handful of store facts every template needs. Passed in rather than read
 * from Env so templates stay pure and unit-testable; `storeContext()` below is
 * the one-liner call sites use.
 */
export interface StoreContext {
  storeName: string;
  /** Absolute origin, no trailing slash. */
  siteUrl: string;
  supportEmail: string;
}

export function storeContext(env: Env): StoreContext {
  return { storeName: storeName(env), siteUrl: siteUrl(env), supportEmail: supportEmail(env) };
}

/** One line of an order, already priced. Money is paise, as everywhere else. */
export interface OrderEmailItem {
  productName: string;
  variantName: string;
  qty: number;
  unitPricePaise: number;
  /** Line total after any allocated discount — what the customer is charged for this line. */
  totalPaise: number;
}

export interface OrderTotals {
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  codFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  /** Indian MRP is tax-inclusive, so GST is shown as contained in the total, not added to it. */
  taxInclusive: boolean;
  couponCode?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Brand tokens                                                               */
/* -------------------------------------------------------------------------- */

const CREAM = '#fbf6ec';
/** Card background. Not #ffffff on purpose: clients that force-invert dark mode turn pure white into a harsh grey slab. */
const PANEL = '#fffdf7';
const INK = '#2a1a10';
const MUTED = '#7a6552';
const MANGO = '#e08712';
const SPICE = '#b8341d';
const RULE = '#ece0c9';

// Quoted family names are needed inside the CSS, so these two are backtick
// strings — the surrounding HTML attributes use double quotes.
const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
const SERIF = `Georgia,'Times New Roman',Times,serif`;

/* -------------------------------------------------------------------------- */
/* Escaping and formatting                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Required on every interpolated value. A customer legitimately named
 * `A & B <x>` must not be able to close a tag or inject an attribute, and their
 * name is in the greeting of nearly every message we send.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Links are built by our own code, but a rendered email is also replayed from
 * stored JSON in the admin inbox, so the scheme is checked here rather than
 * trusted. Anything that is not http(s) — `javascript:`, `data:` — collapses to
 * the site root instead of shipping a live payload to a customer's mail client.
 */
function href(url: string, store: StoreContext): string {
  const trimmed = url.trim();
  return escapeHtml(/^https?:\/\//i.test(trimmed) ? trimmed : store.siteUrl);
}

/** Plain-text counterpart of `href` — same scheme check, no escaping. */
function plainUrl(url: string, store: StoreContext): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : store.siteUrl;
}

const IST = 'Asia/Kolkata';

// Built once at module scope; assembling from parts rather than trusting a
// locale pattern guarantees "Tue, 28 Jul 2026" on every ICU version a Worker
// might be running, instead of drifting to "28/07/2026" or "Tue 28 Jul 2026".
const IST_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const IST_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** Epoch ms → "Tue, 28 Jul 2026", always in IST. */
function formatDate(epochMs: number): string {
  const parts = IST_DATE.formatToParts(new Date(epochMs));
  return `${part(parts, 'weekday')}, ${part(parts, 'day')} ${part(parts, 'month')} ${part(parts, 'year')}`;
}

/** Epoch ms → "Tue, 28 Jul 2026, 4:35 pm IST". Used where the exact moment matters. */
function formatDateTime(epochMs: number): string {
  const parts = IST_TIME.formatToParts(new Date(epochMs));
  const hour = part(parts, 'hour').replace(/^0/, '');
  const time = `${hour}:${part(parts, 'minute')} ${part(parts, 'dayPeriod').toLowerCase()}`;
  return `${formatDate(epochMs)}, ${time} IST`;
}

/* -------------------------------------------------------------------------- */
/* HTML building blocks                                                       */
/* -------------------------------------------------------------------------- */

interface LayoutInput {
  store: StoreContext;
  /** Document <title> and the heading the reader sees first. */
  title: string;
  /** Inbox preview line. Kept distinct from the first paragraph so the list view reads well. */
  preheader: string;
  /** Card contents. INVARIANT: every interpolated value inside is already escaped. */
  body: string;
  /** Marketing mail only. Transactional mail must never offer an unsubscribe. */
  unsubscribeUrl?: string;
  /** Internal alerts get an operations footer instead of the customer one. */
  internal?: boolean;
}

function layout(input: LayoutInput): string {
  const { store } = input;
  const brand = escapeHtml(store.storeName);
  const support = escapeHtml(store.supportEmail);

  const footer = input.internal
    ? [`Internal alert from the ${brand} storefront. This message is not sent to customers.`]
    : [
        `${brand} — packed and posted from Bengaluru, Karnataka, India.`,
        `Questions? Write to <a href="mailto:${support}" style="color:${SPICE};text-decoration:underline;">${support}</a> and a person will reply.`,
        input.unsubscribeUrl
          ? `You are getting this because you asked to be told when this jar came back. <a href="${href(input.unsubscribeUrl, store)}" style="color:${SPICE};text-decoration:underline;">Unsubscribe</a> and we will stop.`
          : 'You are getting this because you placed an order or hold an account with us.',
      ];

  const footerHtml = footer
    .map(
      (line) =>
        `<p style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">${line}</p>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${CREAM};color:${INK};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${CREAM};mso-hide:all;">${escapeHtml(input.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:${CREAM};">
<tr>
<td align="center" style="padding:24px 12px 32px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;">
<tr>
<td align="center" style="padding:4px 0 18px;font-family:${SERIF};font-size:20px;line-height:1.3;letter-spacing:0.01em;color:${INK};">${brand}</td>
</tr>
<tr>
<td style="background-color:${PANEL};border:1px solid ${RULE};border-top:3px solid ${MANGO};border-radius:6px;padding:28px 30px 26px;">
${input.body}
</td>
</tr>
<tr>
<td style="padding:20px 8px 0;">
${footerHtml}
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

function h1(text: string): string {
  return `<h1 style="margin:0 0 14px;font-family:${SERIF};font-size:23px;line-height:1.3;font-weight:normal;color:${INK};">${text}</h1>`;
}

function eyebrow(text: string): string {
  return `<p style="margin:0 0 8px;font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.1em;text-transform:uppercase;font-weight:600;color:${SPICE};">${text}</p>`;
}

function para(html: string): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${INK};">${html}</p>`;
}

function note(html: string): string {
  return `<p style="margin:0 0 12px;font-family:${SANS};font-size:13px;line-height:1.6;color:${MUTED};">${html}</p>`;
}

function divider(): string {
  return `<div style="height:1px;line-height:1px;font-size:0;margin:20px 0;background-color:${RULE};">&nbsp;</div>`;
}

function button(label: string, url: string, store: StoreContext): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:4px 0 16px;">
<tr>
<td align="center" bgcolor="${SPICE}" style="background-color:${SPICE};border-radius:4px;">
<a href="${href(url, store)}" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:15px;line-height:1;font-weight:600;color:${CREAM};text-decoration:none;">${escapeHtml(label)}</a>
</td>
</tr>
</table>`;
}

/** Some clients (and some corporate proxies) mangle buttons, so the raw link always follows. */
function linkFallback(url: string, store: StoreContext): string {
  const safe = href(url, store);
  return `<p style="margin:0 0 12px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">If the button does not work, paste this into your browser:<br><a href="${safe}" style="color:${SPICE};text-decoration:underline;">${safe}</a></p>`;
}

/** Label/value pairs — courier, AWB, payment method. Rows with an empty value are dropped. */
function facts(rows: Array<[string, string]>): string {
  const body = rows
    .filter(([, value]) => value.length > 0)
    .map(
      ([label, value]) =>
        `<tr>
<td style="padding:5px 14px 5px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${MUTED};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
<td style="padding:5px 0;font-family:${SANS};font-size:14px;line-height:1.5;color:${INK};vertical-align:top;">${escapeHtml(value)}</td>
</tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;">${body}</table>`;
}

function addressHtml(address: AddressSnapshot): string {
  const lines = [
    address.full_name,
    address.line1,
    address.line2 ?? '',
    address.landmark ? `Near ${address.landmark}` : '',
    `${address.city}, ${address.state} ${address.pincode}`,
    address.country,
    address.phone,
  ].filter((line) => line.trim().length > 0);

  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.65;color:${INK};">${lines
    .map((line) => escapeHtml(line))
    .join('<br>')}</p>`;
}

function addressText(address: AddressSnapshot): string {
  return [
    address.full_name,
    address.line1,
    address.line2 ?? '',
    address.landmark ? `Near ${address.landmark}` : '',
    `${address.city}, ${address.state} ${address.pincode}`,
    address.country,
    address.phone,
  ]
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Itemised order table                                                       */
/* -------------------------------------------------------------------------- */

function totalsRows(totals: OrderTotals): Array<{ label: string; value: string; strong?: boolean }> {
  const rows: Array<{ label: string; value: string; strong?: boolean }> = [
    { label: 'Subtotal', value: formatPaise(totals.subtotalPaise) },
  ];

  // Everything between subtotal and total is conditional — a zero shipping or a
  // zero COD fee row is noise, and an absent GST row is correct for an unregistered
  // seller rather than a bug.
  if (totals.discountPaise > 0) {
    const code = totals.couponCode ? ` (${totals.couponCode})` : '';
    rows.push({ label: `Discount${code}`, value: formatPaise(-totals.discountPaise) });
  }
  if (totals.shippingPaise > 0) rows.push({ label: 'Shipping', value: formatPaise(totals.shippingPaise) });
  if (totals.codFeePaise > 0) rows.push({ label: 'Cash on delivery fee', value: formatPaise(totals.codFeePaise) });
  if (totals.taxPaise > 0) {
    rows.push({
      label: totals.taxInclusive ? 'GST (included above)' : 'GST',
      value: formatPaise(totals.taxPaise),
    });
  }

  rows.push({ label: 'Total', value: formatPaise(totals.totalPaise), strong: true });
  return rows;
}

function itemsTableHtml(items: OrderEmailItem[], totals: OrderTotals): string {
  const head = `<tr>
<th align="left" style="padding:0 0 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${MUTED};">Item</th>
<th align="center" style="padding:0 0 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${MUTED};">Qty</th>
<th align="right" style="padding:0 0 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${MUTED};">Amount</th>
</tr>`;

  const body = items
    .map(
      (item) => `<tr>
<td align="left" style="padding:11px 8px 11px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.5;color:${INK};">${escapeHtml(item.productName)}<br><span style="font-size:12px;color:${MUTED};">${escapeHtml(item.variantName)} &middot; ${formatPaise(item.unitPricePaise)} each</span></td>
<td align="center" style="padding:11px 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.5;color:${INK};white-space:nowrap;vertical-align:top;">${item.qty}</td>
<td align="right" style="padding:11px 0 11px 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.5;color:${INK};white-space:nowrap;vertical-align:top;">${formatPaise(item.totalPaise)}</td>
</tr>`,
    )
    .join('');

  const foot = totalsRows(totals)
    .map((row) => {
      const weight = row.strong ? '600' : 'normal';
      const size = row.strong ? '16px' : '14px';
      const colour = row.strong ? INK : MUTED;
      const border = row.strong ? `border-top:1px solid ${RULE};` : '';
      const pad = row.strong ? '12px' : '5px';
      return `<tr>
<td colspan="2" align="right" style="padding:${pad} 12px ${pad} 0;${border}font-family:${SANS};font-size:${size};line-height:1.5;font-weight:${weight};color:${colour};">${escapeHtml(row.label)}</td>
<td align="right" style="padding:${pad} 0;${border}font-family:${SANS};font-size:${size};line-height:1.5;font-weight:${weight};color:${INK};white-space:nowrap;">${escapeHtml(row.value)}</td>
</tr>`;
    })
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 6px;">${head}${body}${foot}</table>`;
}

/* -------------------------------------------------------------------------- */
/* Plain-text building blocks                                                 */
/* -------------------------------------------------------------------------- */

const TEXT_WIDTH = 52;
const TEXT_RULE = '-'.repeat(TEXT_WIDTH);

/** Right-aligns the amount so the text receipt still lines up in a monospaced view. */
function padRow(label: string, value: string): string {
  const gap = Math.max(1, TEXT_WIDTH - label.length - value.length);
  return `${label}${' '.repeat(gap)}${value}`;
}

function itemsTableText(items: OrderEmailItem[], totals: OrderTotals): string {
  const lines: string[] = [TEXT_RULE];
  for (const item of items) {
    lines.push(`${item.productName} — ${item.variantName}`);
    lines.push(padRow(`  ${item.qty} x ${formatPaise(item.unitPricePaise)}`, formatPaise(item.totalPaise)));
  }
  lines.push(TEXT_RULE);
  for (const row of totalsRows(totals)) {
    lines.push(padRow(row.label, row.value));
  }
  lines.push(TEXT_RULE);
  return lines.join('\n');
}

interface TextLayoutInput {
  store: StoreContext;
  body: string;
  unsubscribeUrl?: string;
  internal?: boolean;
}

function textLayout(input: TextLayoutInput): string {
  const { store } = input;
  const footer = input.internal
    ? [`Internal alert from the ${store.storeName} storefront. Not sent to customers.`]
    : [
        `${store.storeName} — packed and posted from Bengaluru, Karnataka, India.`,
        `Questions? Write to ${store.supportEmail} and a person will reply.`,
        input.unsubscribeUrl
          ? `You are getting this because you asked to be told when this jar came back.\nUnsubscribe: ${plainUrl(input.unsubscribeUrl, store)}`
          : 'You are getting this because you placed an order or hold an account with us.',
      ];

  return `${store.storeName}\n\n${input.body.trim()}\n\n${TEXT_RULE}\n${footer.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* 1. Email verification                                                      */
/* -------------------------------------------------------------------------- */

export interface VerifyEmailInput {
  store: StoreContext;
  name: string;
  verifyUrl: string;
  /** Epoch ms. The link is minted with a 24 hour life. */
  expiresAt: number;
}

export function verifyEmail(input: VerifyEmailInput): RenderedEmail {
  const { store } = input;
  const subject = `Confirm your email — ${store.storeName}`;
  const expiry = formatDateTime(input.expiresAt);

  const html = layout({
    store,
    title: subject,
    preheader: 'One tap to confirm your email address and finish setting up your account.',
    body: [
      eyebrow('Confirm your email'),
      h1(`Hello ${escapeHtml(input.name)},`),
      para('Confirm this email address and your account is ready — order history, saved addresses, and a delivery update at every step.'),
      button('Confirm my email', input.verifyUrl, store),
      linkFallback(input.verifyUrl, store),
      note(`This link works for 24 hours, until ${escapeHtml(expiry)}. After that, ask for a fresh one from the sign-in page.`),
      note('If you did not create an account with us, ignore this email and nothing happens.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `Hello ${input.name},

Confirm this email address and your account is ready — order history,
saved addresses, and a delivery update at every step.

Confirm your email:
${plainUrl(input.verifyUrl, store)}

This link works for 24 hours, until ${expiry}. After that, ask for a
fresh one from the sign-in page.

If you did not create an account with us, ignore this email and nothing
happens.`,
  });

  return { subject, text, html, template: 'auth_verify_email' };
}

/* -------------------------------------------------------------------------- */
/* 2. Password reset                                                          */
/* -------------------------------------------------------------------------- */

export interface PasswordResetInput {
  store: StoreContext;
  name: string;
  resetUrl: string;
  /** Epoch ms. Reset links are short-lived — one hour. */
  expiresAt: number;
}

export function passwordReset(input: PasswordResetInput): RenderedEmail {
  const { store } = input;
  const subject = `Reset your password — ${store.storeName}`;
  const expiry = formatDateTime(input.expiresAt);

  const html = layout({
    store,
    title: subject,
    preheader: 'Set a new password. The link is good for one hour.',
    body: [
      eyebrow('Password reset'),
      h1(`Hello ${escapeHtml(input.name)},`),
      para('Someone asked to reset the password on this account. Use the button below to set a new one.'),
      button('Set a new password', input.resetUrl, store),
      linkFallback(input.resetUrl, store),
      note(`This link expires in one hour, at ${escapeHtml(expiry)}, and can be used only once.`),
      note(
        `If this was not you, no action is needed — your current password still works. Tell us at <a href="mailto:${escapeHtml(store.supportEmail)}" style="color:${SPICE};text-decoration:underline;">${escapeHtml(store.supportEmail)}</a> if you keep getting these.`,
      ),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `Hello ${input.name},

Someone asked to reset the password on this account. Use the link below
to set a new one.

Set a new password:
${plainUrl(input.resetUrl, store)}

This link expires in one hour, at ${expiry}, and can be used only once.

If this was not you, no action is needed — your current password still
works. Tell us at ${store.supportEmail} if you keep getting these.`,
  });

  return { subject, text, html, template: 'auth_password_reset' };
}

/* -------------------------------------------------------------------------- */
/* 3. Password changed                                                        */
/* -------------------------------------------------------------------------- */

export interface PasswordChangedInput {
  store: StoreContext;
  name: string;
  /** Epoch ms of the change. */
  changedAt: number;
  /** Best-effort request context, shown so a customer can recognise their own action. */
  ip?: string | null;
  device?: string | null;
}

export function passwordChanged(input: PasswordChangedInput): RenderedEmail {
  const { store } = input;
  const subject = `Your password was changed — ${store.storeName}`;
  const when = formatDateTime(input.changedAt);

  const html = layout({
    store,
    title: subject,
    preheader: `Password changed on ${formatDate(input.changedAt)}. If this was not you, write to us now.`,
    body: [
      eyebrow('Security notice'),
      h1(`Hello ${escapeHtml(input.name)},`),
      para('The password on your account was changed just now. Every other signed-in session has been signed out.'),
      facts([
        ['Changed', when],
        ['Device', input.device ?? ''],
        ['IP address', input.ip ?? ''],
      ]),
      note(
        `If you made this change, there is nothing to do. If you did not, write to <a href="mailto:${escapeHtml(store.supportEmail)}" style="color:${SPICE};text-decoration:underline;">${escapeHtml(store.supportEmail)}</a> straight away and we will lock the account while we sort it out.`,
      ),
    ].join(''),
  });

  const details = [`Changed: ${when}`];
  if (input.device) details.push(`Device: ${input.device}`);
  if (input.ip) details.push(`IP address: ${input.ip}`);

  const text = textLayout({
    store,
    body: `Hello ${input.name},

The password on your account was changed just now. Every other
signed-in session has been signed out.

${details.join('\n')}

If you made this change, there is nothing to do. If you did not, write
to ${store.supportEmail} straight away and we will lock the account
while we sort it out.`,
  });

  return { subject, text, html, template: 'auth_password_changed' };
}

/* -------------------------------------------------------------------------- */
/* 4. Welcome                                                                 */
/* -------------------------------------------------------------------------- */

export interface WelcomeInput {
  store: StoreContext;
  name: string;
  shopUrl: string;
}

export function welcome(input: WelcomeInput): RenderedEmail {
  const { store } = input;
  const subject = `Welcome to ${store.storeName}`;

  const html = layout({
    store,
    title: subject,
    preheader: 'Your email is confirmed. Here is what we make and how it reaches you.',
    body: [
      eyebrow('Your account is ready'),
      h1(`Welcome, ${escapeHtml(input.name)}.`),
      para('Your email is confirmed, so your account is live. Orders, addresses and delivery updates now live in one place.'),
      para(
        'We cook in small batches — raw mango cut and salted the same week it arrives, sun-dried spices, cold-pressed sesame oil, no preservatives. That means a jar is sometimes sold out, and that is the point.',
      ),
      button('See what is in stock', input.shopUrl, store),
      divider(),
      note('A jar keeps for a year unopened. Once opened, use a dry spoon and keep it out of the sun — that is the whole trick.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `Welcome, ${input.name}.

Your email is confirmed, so your account is live. Orders, addresses and
delivery updates now live in one place.

We cook in small batches — raw mango cut and salted the same week it
arrives, sun-dried spices, cold-pressed sesame oil, no preservatives.
That means a jar is sometimes sold out, and that is the point.

See what is in stock:
${plainUrl(input.shopUrl, store)}

A jar keeps for a year unopened. Once opened, use a dry spoon and keep
it out of the sun — that is the whole trick.`,
  });

  return { subject, text, html, template: 'auth_welcome' };
}

/* -------------------------------------------------------------------------- */
/* 5. Order confirmation                                                      */
/* -------------------------------------------------------------------------- */

export interface OrderConfirmationInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  /** Epoch ms. */
  placedAt: number;
  items: OrderEmailItem[];
  totals: OrderTotals;
  paymentMethod: PaymentMethod;
  shippingAddress: AddressSnapshot;
  /** Epoch ms, or null when the courier has not given an estimate yet. */
  estimatedDeliveryAt: number | null;
  trackUrl: string;
  customerNote?: string | null;
}

export function orderConfirmation(input: OrderConfirmationInput): RenderedEmail {
  const { store, totals } = input;
  const subject = `Order ${input.orderNumber} confirmed — ${store.storeName}`;
  const isCod = input.paymentMethod === 'cod';
  const paymentLabel = isCod
    ? `Cash on delivery — ${formatPaise(totals.totalPaise)} due to the courier`
    : `Paid online — ${formatPaise(totals.totalPaise)}`;
  const eta = input.estimatedDeliveryAt
    ? `Expected by ${formatDate(input.estimatedDeliveryAt)}`
    : 'We will share a date the moment the courier picks it up';

  const html = layout({
    store,
    title: subject,
    preheader: `We have your order for ${formatPaise(totals.totalPaise)}. ${eta}.`,
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`Thank you, ${escapeHtml(input.customerName)}.`),
      para('Your order is confirmed. We pack by hand, so give us a day at the bench before the courier takes over.'),
      facts([
        ['Order', input.orderNumber],
        ['Placed', formatDateTime(input.placedAt)],
        ['Payment', paymentLabel],
        ['Delivery', eta],
      ]),
      button('Track this order', input.trackUrl, store),
      divider(),
      eyebrow('What is in the box'),
      itemsTableHtml(input.items, totals),
      divider(),
      eyebrow('Shipping to'),
      addressHtml(input.shippingAddress),
      input.customerNote ? note(`Your note to us: ${escapeHtml(input.customerNote)}`) : '',
      note('Wrong address or second thoughts? Reply to this email within a few hours and we can still change it.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `Thank you, ${input.customerName}.

Your order is confirmed. We pack by hand, so give us a day at the bench
before the courier takes over.

Order: ${input.orderNumber}
Placed: ${formatDateTime(input.placedAt)}
Payment: ${paymentLabel}
Delivery: ${eta}

WHAT IS IN THE BOX
${itemsTableText(input.items, totals)}

SHIPPING TO
${addressText(input.shippingAddress)}
${input.customerNote ? `\nYour note to us: ${input.customerNote}\n` : ''}
Track this order:
${plainUrl(input.trackUrl, store)}

Wrong address or second thoughts? Reply to this email within a few
hours and we can still change it.`,
  });

  return { subject, text, html, template: 'order_confirmation' };
}

/* -------------------------------------------------------------------------- */
/* 6. Payment failed                                                          */
/* -------------------------------------------------------------------------- */

export interface PaymentFailedInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  totalPaise: number;
  retryUrl: string;
  /** Human-readable failure reason from the payment provider, when it gave one. */
  reason?: string | null;
  /** Epoch ms the stock reservation lapses, or null when nothing is being held. */
  reservedUntil?: number | null;
}

export function paymentFailed(input: PaymentFailedInput): RenderedEmail {
  const { store } = input;
  const subject = `Order ${input.orderNumber} — payment did not go through`;

  const html = layout({
    store,
    title: subject,
    preheader: `Your ${formatPaise(input.totalPaise)} payment did not complete. The jars are still held for you.`,
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`${escapeHtml(input.customerName)}, the payment did not go through.`),
      para(
        `The bank did not complete the ${formatPaise(input.totalPaise)} payment for this order, so nothing has been charged. If you see a debit, it is a hold and it reverses on its own in a few days.`,
      ),
      facts([
        ['Order', input.orderNumber],
        ['Amount', formatPaise(input.totalPaise)],
        ['Reason', input.reason ?? ''],
      ]),
      button('Try the payment again', input.retryUrl, store),
      linkFallback(input.retryUrl, store),
      input.reservedUntil
        ? note(
            `We are holding your jars until ${escapeHtml(formatDateTime(input.reservedUntil))}. After that they go back on sale and you would need to order again.`,
          )
        : note('Your basket is saved, though stock is not held — popular sizes do sell out.'),
      note('A different card or UPI app usually clears it. If it fails twice, reply here and we will send a direct payment link.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `${input.customerName}, the payment did not go through.

The bank did not complete the ${formatPaise(input.totalPaise)} payment for this order, so
nothing has been charged. If you see a debit, it is a hold and it
reverses on its own in a few days.

Order: ${input.orderNumber}
Amount: ${formatPaise(input.totalPaise)}${input.reason ? `\nReason: ${input.reason}` : ''}

Try the payment again:
${plainUrl(input.retryUrl, store)}

${
  input.reservedUntil
    ? `We are holding your jars until ${formatDateTime(input.reservedUntil)}. After that\nthey go back on sale and you would need to order again.`
    : 'Your basket is saved, though stock is not held — popular sizes do sell out.'
}

A different card or UPI app usually clears it. If it fails twice, reply
here and we will send a direct payment link.`,
  });

  return { subject, text, html, template: 'order_payment_failed' };
}

/* -------------------------------------------------------------------------- */
/* 7. Order cancelled                                                         */
/* -------------------------------------------------------------------------- */

export interface OrderCancelledInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  /** Epoch ms. */
  cancelledAt: number;
  reason: string;
  paymentMethod: PaymentMethod;
  /** Amount going back to the customer, paise. Zero for an unpaid or COD order. */
  refundPaise: number;
  shopUrl: string;
}

export function orderCancelled(input: OrderCancelledInput): RenderedEmail {
  const { store } = input;
  const subject = `Order ${input.orderNumber} cancelled — ${store.storeName}`;
  const hasRefund = input.refundPaise > 0;

  const refundLine = hasRefund
    ? `We have started a refund of ${formatPaise(input.refundPaise)} to the way you paid. Banks take five to seven working days to show it.`
    : input.paymentMethod === 'cod'
      ? 'Nothing was collected for this order, so there is nothing to refund.'
      : 'No payment was captured for this order, so there is nothing to refund.';

  const html = layout({
    store,
    title: subject,
    preheader: hasRefund
      ? `Cancelled. A refund of ${formatPaise(input.refundPaise)} is on its way.`
      : 'Cancelled. Nothing was charged.',
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`${escapeHtml(input.customerName)}, this order has been cancelled.`),
      para(escapeHtml(refundLine)),
      facts([
        ['Order', input.orderNumber],
        ['Cancelled', formatDateTime(input.cancelledAt)],
        ['Reason', input.reason],
        ['Refund', hasRefund ? formatPaise(input.refundPaise) : ''],
      ]),
      button('Browse what is in stock', input.shopUrl, store),
      note('If this cancellation is a surprise to you, reply to this email — we would rather fix it than lose the order.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `${input.customerName}, this order has been cancelled.

${refundLine}

Order: ${input.orderNumber}
Cancelled: ${formatDateTime(input.cancelledAt)}
Reason: ${input.reason}${hasRefund ? `\nRefund: ${formatPaise(input.refundPaise)}` : ''}

Browse what is in stock:
${plainUrl(input.shopUrl, store)}

If this cancellation is a surprise to you, reply to this email — we
would rather fix it than lose the order.`,
  });

  return { subject, text, html, template: 'order_cancelled' };
}

/* -------------------------------------------------------------------------- */
/* 8. Order shipped                                                           */
/* -------------------------------------------------------------------------- */

export interface OrderShippedInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  courierName: string;
  awbCode: string;
  trackingUrl: string;
  /** Epoch ms. */
  shippedAt: number;
  /** Epoch ms, or null when the courier gave no estimate. */
  estimatedDeliveryAt: number | null;
  items: OrderEmailItem[];
  shippingAddress: AddressSnapshot;
}

export function orderShipped(input: OrderShippedInput): RenderedEmail {
  const { store } = input;
  const subject = `Order ${input.orderNumber} is on its way — ${store.storeName}`;
  const eta = input.estimatedDeliveryAt ? formatDate(input.estimatedDeliveryAt) : '';

  const itemLines = input.items
    .map((item) => `${escapeHtml(item.productName)} — ${escapeHtml(item.variantName)} &times; ${item.qty}`)
    .join('<br>');

  const html = layout({
    store,
    title: subject,
    preheader: eta ? `Handed to ${input.courierName}. Expected by ${eta}.` : `Handed to ${input.courierName}.`,
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`It is on the road, ${escapeHtml(input.customerName)}.`),
      para('Your jars are packed, taped and handed to the courier. Here is everything you need to follow the parcel.'),
      facts([
        ['Courier', input.courierName],
        ['Tracking number', input.awbCode],
        ['Dispatched', formatDate(input.shippedAt)],
        ['Expected by', eta],
      ]),
      button('Track this parcel', input.trackingUrl, store),
      linkFallback(input.trackingUrl, store),
      divider(),
      eyebrow('In this parcel'),
      `<p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.7;color:${INK};">${itemLines}</p>`,
      eyebrow('Delivering to'),
      addressHtml(input.shippingAddress),
      note('Tracking usually goes quiet for a day after pickup while the parcel moves between hubs. That is normal.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `It is on the road, ${input.customerName}.

Your jars are packed, taped and handed to the courier. Here is
everything you need to follow the parcel.

Order: ${input.orderNumber}
Courier: ${input.courierName}
Tracking number: ${input.awbCode}
Dispatched: ${formatDate(input.shippedAt)}${eta ? `\nExpected by: ${eta}` : ''}

Track this parcel:
${plainUrl(input.trackingUrl, store)}

IN THIS PARCEL
${input.items.map((item) => `${item.productName} — ${item.variantName} x ${item.qty}`).join('\n')}

DELIVERING TO
${addressText(input.shippingAddress)}

Tracking usually goes quiet for a day after pickup while the parcel
moves between hubs. That is normal.`,
  });

  return { subject, text, html, template: 'order_shipped' };
}

/* -------------------------------------------------------------------------- */
/* 9. Out for delivery                                                        */
/* -------------------------------------------------------------------------- */

export interface OrderOutForDeliveryInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  courierName: string;
  awbCode: string;
  trackingUrl: string;
  paymentMethod: PaymentMethod;
  /** Amount the courier will collect, paise. Ignored unless paymentMethod is 'cod'. */
  codAmountPaise: number;
}

export function orderOutForDelivery(input: OrderOutForDeliveryInput): RenderedEmail {
  const { store } = input;
  const subject = `Order ${input.orderNumber} is arriving today`;
  const isCod = input.paymentMethod === 'cod';
  const codLine = isCod ? `Keep ${formatPaise(input.codAmountPaise)} ready — the courier collects cash or UPI at the door.` : '';

  const html = layout({
    store,
    title: subject,
    preheader: isCod ? `Out for delivery. ${formatPaise(input.codAmountPaise)} due at the door.` : 'Out for delivery today.',
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`Arriving today, ${escapeHtml(input.customerName)}.`),
      para(`${escapeHtml(input.courierName)} has your parcel out for delivery. Someone should be at the address to take it.`),
      codLine ? para(`<strong style="color:${SPICE};">${escapeHtml(codLine)}</strong>`) : '',
      facts([
        ['Courier', input.courierName],
        ['Tracking number', input.awbCode],
        ['To collect', isCod ? formatPaise(input.codAmountPaise) : ''],
      ]),
      button('Track the delivery', input.trackingUrl, store),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `Arriving today, ${input.customerName}.

${input.courierName} has your parcel out for delivery.
Someone should be at the address to take it.
${codLine ? `\n${codLine}\n` : ''}
Order: ${input.orderNumber}
Courier: ${input.courierName}
Tracking number: ${input.awbCode}${isCod ? `\nTo collect: ${formatPaise(input.codAmountPaise)}` : ''}

Track the delivery:
${plainUrl(input.trackingUrl, store)}`,
  });

  return { subject, text, html, template: 'order_out_for_delivery' };
}

/* -------------------------------------------------------------------------- */
/* 10. Delivered                                                              */
/* -------------------------------------------------------------------------- */

export interface OrderDeliveredInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  /** Epoch ms. */
  deliveredAt: number;
  reviewUrl: string;
}

export function orderDelivered(input: OrderDeliveredInput): RenderedEmail {
  const { store } = input;
  const subject = `Order ${input.orderNumber} delivered — thank you`;

  const html = layout({
    store,
    title: subject,
    preheader: 'Delivered. Tell us how it tastes when you get to it.',
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`Delivered, ${escapeHtml(input.customerName)}.`),
      para(`The courier marked your parcel delivered on ${escapeHtml(formatDateTime(input.deliveredAt))}. Thank you for buying from a very small kitchen.`),
      para('Open it with a dry spoon, keep the jar out of direct sun, and it will hold its edge for months. No refrigeration needed.'),
      button('Leave a review', input.reviewUrl, store),
      note('An honest few lines helps more than you would think — we read every one, and it is how the next person decides.'),
      divider(),
      note('If the parcel has not actually reached you, or a jar arrived damaged, reply within 48 hours with a photo and we will replace it.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `Delivered, ${input.customerName}.

The courier marked your parcel delivered on ${formatDateTime(input.deliveredAt)}.
Thank you for buying from a very small kitchen.

Open it with a dry spoon, keep the jar out of direct sun, and it will
hold its edge for months. No refrigeration needed.

Leave a review:
${plainUrl(input.reviewUrl, store)}

An honest few lines helps more than you would think — we read every
one, and it is how the next person decides.

If the parcel has not actually reached you, or a jar arrived damaged,
reply within 48 hours with a photo and we will replace it.`,
  });

  return { subject, text, html, template: 'order_delivered' };
}

/* -------------------------------------------------------------------------- */
/* 11. Refund issued                                                          */
/* -------------------------------------------------------------------------- */

export interface RefundIssuedInput {
  store: StoreContext;
  orderNumber: string;
  customerName: string;
  amountPaise: number;
  /**
   * Where the money is going, in the customer's words — "the UPI account you
   * paid from", "your card ending 4242". The caller supplies it so no payment
   * vendor is named inside a template.
   */
  refundMethod: string;
  /** Epoch ms. */
  issuedAt: number;
  reason?: string | null;
  orderUrl: string;
  /** True when this settles only part of the order — changes the wording. */
  isPartial: boolean;
}

export function refundIssued(input: RefundIssuedInput): RenderedEmail {
  const { store } = input;
  const subject = `Order ${input.orderNumber} — refund of ${formatPaise(input.amountPaise)} issued`;
  const opening = input.isPartial
    ? `We have refunded ${formatPaise(input.amountPaise)} of this order to ${input.refundMethod}.`
    : `We have refunded ${formatPaise(input.amountPaise)} to ${input.refundMethod}.`;

  const html = layout({
    store,
    title: subject,
    preheader: `${formatPaise(input.amountPaise)} is on its way back to you.`,
    body: [
      eyebrow(`Order ${escapeHtml(input.orderNumber)}`),
      h1(`${escapeHtml(input.customerName)}, your refund is on its way.`),
      para(escapeHtml(opening)),
      facts([
        ['Order', input.orderNumber],
        ['Refund amount', formatPaise(input.amountPaise)],
        ['Back to', input.refundMethod],
        ['Issued', formatDateTime(input.issuedAt)],
        ['Reason', input.reason ?? ''],
      ]),
      para('Banks take five to seven working days to post a refund, sometimes longer over a weekend or a bank holiday. It will appear against the original payment, not as a fresh credit.'),
      button('View this order', input.orderUrl, store),
      note('If it has not landed after seven working days, reply with this email and we will chase it with the bank on your behalf.'),
    ].join(''),
  });

  const text = textLayout({
    store,
    body: `${input.customerName}, your refund is on its way.

${opening}

Order: ${input.orderNumber}
Refund amount: ${formatPaise(input.amountPaise)}
Back to: ${input.refundMethod}
Issued: ${formatDateTime(input.issuedAt)}${input.reason ? `\nReason: ${input.reason}` : ''}

Banks take five to seven working days to post a refund, sometimes
longer over a weekend or a bank holiday. It will appear against the
original payment, not as a fresh credit.

View this order:
${plainUrl(input.orderUrl, store)}

If it has not landed after seven working days, reply with this email
and we will chase it with the bank on your behalf.`,
  });

  return { subject, text, html, template: 'order_refund_issued' };
}

/* -------------------------------------------------------------------------- */
/* 12. Back in stock (marketing)                                              */
/* -------------------------------------------------------------------------- */

export interface BackInStockInput {
  store: StoreContext;
  name: string;
  productName: string;
  variantName: string;
  pricePaise: number;
  buyUrl: string;
  /** Marketing mail, so this is required — the footer must offer a way out. */
  unsubscribeUrl: string;
}

export function backInStock(input: BackInStockInput): RenderedEmail {
  const { store } = input;
  const subject = `Back in stock: ${input.productName} ${input.variantName} — ${store.storeName}`;

  const html = layout({
    store,
    title: subject,
    preheader: `${input.productName} ${input.variantName} is back on the shelf at ${formatPaise(input.pricePaise)}.`,
    unsubscribeUrl: input.unsubscribeUrl,
    body: [
      eyebrow('Back in stock'),
      h1(`${escapeHtml(input.productName)} — ${escapeHtml(input.variantName)}`),
      para(`Hello ${escapeHtml(input.name)}, the batch you asked about is jarred and back on the shelf at ${formatPaise(input.pricePaise)}.`),
      para('Batches are small and this one usually goes within a week, so we are telling everyone on the list at the same time rather than holding one back.'),
      button('Buy a jar', input.buyUrl, store),
      linkFallback(input.buyUrl, store),
    ].join(''),
  });

  const text = textLayout({
    store,
    unsubscribeUrl: input.unsubscribeUrl,
    body: `BACK IN STOCK
${input.productName} — ${input.variantName}

Hello ${input.name}, the batch you asked about is jarred and back on the
shelf at ${formatPaise(input.pricePaise)}.

Batches are small and this one usually goes within a week, so we are
telling everyone on the list at the same time rather than holding one
back.

Buy a jar:
${plainUrl(input.buyUrl, store)}`,
  });

  return { subject, text, html, template: 'catalog_back_in_stock' };
}

/* -------------------------------------------------------------------------- */
/* 13. Admin — new order                                                      */
/* -------------------------------------------------------------------------- */

export interface AdminNewOrderInput {
  store: StoreContext;
  orderNumber: string;
  /** Epoch ms. */
  placedAt: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  isGuest: boolean;
  paymentMethod: PaymentMethod;
  items: OrderEmailItem[];
  totals: OrderTotals;
  shippingAddress: AddressSnapshot;
  adminUrl: string;
  customerNote?: string | null;
}

export function adminNewOrder(input: AdminNewOrderInput): RenderedEmail {
  const { store, totals } = input;
  const methodLabel = input.paymentMethod === 'cod' ? 'COD' : 'prepaid';
  const subject = `Order ${input.orderNumber} placed — ${formatPaise(totals.totalPaise)} (${methodLabel})`;
  const unitCount = input.items.reduce((sum, item) => sum + item.qty, 0);

  const html = layout({
    store,
    title: subject,
    internal: true,
    preheader: `${unitCount} unit(s), ${formatPaise(totals.totalPaise)}, ${methodLabel}, to ${input.shippingAddress.city}.`,
    body: [
      eyebrow('New order'),
      h1(escapeHtml(input.orderNumber)),
      facts([
        ['Placed', formatDateTime(input.placedAt)],
        ['Total', `${formatPaise(totals.totalPaise)} (${methodLabel})`],
        ['Units', String(unitCount)],
        ['Customer', `${input.customerName}${input.isGuest ? ' (guest)' : ''}`],
        ['Email', input.customerEmail],
        ['Phone', input.customerPhone],
        ['Destination', `${input.shippingAddress.city}, ${input.shippingAddress.state} ${input.shippingAddress.pincode}`],
      ]),
      button('Open in admin', input.adminUrl, store),
      divider(),
      eyebrow('Items'),
      itemsTableHtml(input.items, totals),
      divider(),
      eyebrow('Ship to'),
      addressHtml(input.shippingAddress),
      input.customerNote ? note(`Customer note: ${escapeHtml(input.customerNote)}`) : '',
    ].join(''),
  });

  const text = textLayout({
    store,
    internal: true,
    body: `NEW ORDER ${input.orderNumber}

Placed: ${formatDateTime(input.placedAt)}
Total: ${formatPaise(totals.totalPaise)} (${methodLabel})
Units: ${unitCount}
Customer: ${input.customerName}${input.isGuest ? ' (guest)' : ''}
Email: ${input.customerEmail}
Phone: ${input.customerPhone}

ITEMS
${itemsTableText(input.items, totals)}

SHIP TO
${addressText(input.shippingAddress)}
${input.customerNote ? `\nCustomer note: ${input.customerNote}\n` : ''}
Open in admin:
${plainUrl(input.adminUrl, store)}`,
  });

  return { subject, text, html, template: 'admin_new_order' };
}

/* -------------------------------------------------------------------------- */
/* 14. Admin — low stock                                                      */
/* -------------------------------------------------------------------------- */

export interface LowStockLine {
  sku: string;
  productName: string;
  variantName: string;
  onHand: number;
  reserved: number;
  reorderLevel: number;
}

export interface AdminLowStockInput {
  store: StoreContext;
  lines: LowStockLine[];
  /** Epoch ms the check ran. */
  generatedAt: number;
  adminUrl: string;
}

export function adminLowStock(input: AdminLowStockInput): RenderedEmail {
  const { store } = input;
  const count = input.lines.length;
  const subject = `Low stock — ${count} variant${count === 1 ? '' : 's'} at or below reorder level`;
  const outOfStock = input.lines.filter((line) => line.onHand - line.reserved <= 0).length;
  const urgency =
    outOfStock === 1
      ? 'One of these has no sellable stock left and is turning customers away right now.'
      : `${outOfStock} of these have no sellable stock left and are turning customers away right now.`;

  const head = `<tr>
<th align="left" style="padding:0 8px 8px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${MUTED};">Variant</th>
<th align="right" style="padding:0 8px 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${MUTED};">Free</th>
<th align="right" style="padding:0 0 8px 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${MUTED};">Reorder at</th>
</tr>`;

  const rows = input.lines
    .map((line) => {
      const free = line.onHand - line.reserved;
      // Zero sellable stock is the urgent case — the listing is already unbuyable.
      const colour = free <= 0 ? SPICE : INK;
      return `<tr>
<td align="left" style="padding:10px 8px 10px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.5;color:${INK};">${escapeHtml(line.productName)} — ${escapeHtml(line.variantName)}<br><span style="font-size:12px;color:${MUTED};">${escapeHtml(line.sku)} &middot; ${line.onHand} on hand, ${line.reserved} reserved</span></td>
<td align="right" style="padding:10px 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:15px;line-height:1.5;font-weight:600;color:${colour};white-space:nowrap;vertical-align:top;">${free}</td>
<td align="right" style="padding:10px 0 10px 8px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:14px;line-height:1.5;color:${MUTED};white-space:nowrap;vertical-align:top;">${line.reorderLevel}</td>
</tr>`;
    })
    .join('');

  const html = layout({
    store,
    title: subject,
    internal: true,
    preheader: `${count} variant(s) need a batch${outOfStock > 0 ? `, ${outOfStock} already unsellable` : ''}.`,
    body: [
      eyebrow('Stock alert'),
      h1(`${count} variant${count === 1 ? '' : 's'} need a batch`),
      para(
        `Checked ${escapeHtml(formatDateTime(input.generatedAt))}. ${escapeHtml(
          outOfStock > 0 ? urgency : 'None are out yet, so there is time to cook a batch.',
        )}`,
      ),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 18px;">${head}${rows}</table>`,
      button('Open inventory', input.adminUrl, store),
      note('Free = on hand minus reserved. Reserved stock belongs to unpaid orders and is released when their hold lapses.'),
    ].join(''),
  });

  const textRows = input.lines
    .map((line) => {
      const free = line.onHand - line.reserved;
      return `${line.productName} — ${line.variantName} (${line.sku})\n${padRow(`  free ${free}, on hand ${line.onHand}, reserved ${line.reserved}`, `reorder at ${line.reorderLevel}`)}`;
    })
    .join('\n');

  const text = textLayout({
    store,
    internal: true,
    body: `LOW STOCK — ${count} variant${count === 1 ? '' : 's'} at or below reorder level

Checked ${formatDateTime(input.generatedAt)}.
${outOfStock > 0 ? urgency : 'None are out yet, so there is time to cook a batch.'}

${TEXT_RULE}
${textRows}
${TEXT_RULE}

Open inventory:
${plainUrl(input.adminUrl, store)}

Free = on hand minus reserved. Reserved stock belongs to unpaid orders
and is released when their hold lapses.`,
  });

  return { subject, text, html, template: 'admin_low_stock' };
}
