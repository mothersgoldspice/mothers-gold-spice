/**
 * robots.txt.
 *
 * Generated rather than static because the disallow list has to stay in step
 * with the routes that exist. Everything customer-private is excluded — an
 * indexed `/invoice/…` or `/track/…` URL is somebody's home address in a search
 * result, and those URLs travel in emails where crawlers can find them.
 */

import type { APIRoute } from 'astro';
import { siteUrl } from '../lib/env';

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
  const env = (locals as { runtime?: { env: Record<string, unknown> } }).runtime?.env ?? {};
  const base = siteUrl(env as never);

  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    '# Customer-private. These carry names, addresses and phone numbers.',
    'Disallow: /account/',
    'Disallow: /checkout/',
    'Disallow: /invoice/',
    'Disallow: /track/',
    'Disallow: /admin/',
    'Disallow: /api/',
    // The unsubscribe link carries the address in `?e=`, and it travels in
    // email, which is exactly where crawlers find URLs.
    'Disallow: /unsubscribe',
    '',
    '# Internal working documents, not products.',
    'Disallow: /sitemap',
    'Disallow: /plan',
    'Disallow: /assembly',
    'Disallow: /label-preview',
    'Disallow: /registration',
    'Disallow: /risk-mitigation',
    'Disallow: /suppliers',
    'Disallow: /trademark',
    'Disallow: /setup',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
};
