/**
 * XML sitemap for search engines.
 *
 * Distinct from `/sitemap`, which is the internal visual page map for the
 * family. This one is generated from the live catalogue so a new product is
 * discoverable the moment it goes active, without anyone remembering to edit a
 * list.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../lib/api';
import { siteUrl } from '../lib/env';
import { listProducts } from '../lib/services/catalog';

export const prerender = false;

/** Public marketing pages, with how often they are worth recrawling. */
const STATIC_PAGES: { path: string; priority: string; changefreq: string }[] = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/shop', priority: '0.9', changefreq: 'daily' },
  { path: '/shipping', priority: '0.5', changefreq: 'monthly' },
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireCtx(locals);
  const base = siteUrl(ctx.env);

  const products = await listProducts(ctx.db).catch(() => []);

  const urls = [
    ...STATIC_PAGES.map((p) => ({
      loc: `${base}${p.path}`,
      lastmod: null as number | null,
      priority: p.priority,
      changefreq: p.changefreq,
    })),
    ...products.map((p) => ({
      loc: `${base}/shop/${p.slug}`,
      lastmod: null as number | null,
      priority: '0.8',
      changefreq: 'weekly',
    })),
  ];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) =>
      [
        '  <url>',
        `    <loc>${escapeXml(u.loc)}</loc>`,
        u.lastmod ? `    <lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : '',
        `    <changefreq>${u.changefreq}</changefreq>`,
        `    <priority>${u.priority}</priority>`,
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
};
