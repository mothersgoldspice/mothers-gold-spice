#!/usr/bin/env node
/**
 * Build printable sheets of the thank-you card that goes in the box.
 *
 *   node scripts/make-card-sheet.mjs                    # every design, 4-up A4
 *   node scripts/make-card-sheet.mjs --design letter    # just one
 *   node scripts/make-card-sheet.mjs --bleed            # 1-up true A6 for a print shop
 *
 * Designs live in artifacts/cards/*.svg, drawn at A6 (105 × 148 mm) in millimetre
 * coordinates. This script sizes them for the target sheet, drops a real QR code
 * into the slot each design leaves, and renders to PDF.
 *
 * ─── Why the 4-up card is not exactly A6 ─────────────────────────────────────
 *
 * A6 is precisely a quarter of A4, so four fit with no waste — edge to edge. A
 * home printer cannot print edge to edge; it holds back 5–8 mm. On a card with a
 * cream background that unprinted margin is a white sliver down one side, which
 * reads as a misprint on something whose whole job is to feel considered.
 *
 * So the 4-up sheet sizes cards to the printable area (97 × 140.5 mm) rather
 * than forcing exact A6 and losing the bleed. They are still substantial cards.
 * For true A6, use --bleed and give that file to a print shop, which trims from
 * a larger sheet and has no such limit.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD_DIR = path.join(ROOT, 'artifacts/cards');
const OUT_DIR = path.join(ROOT, 'artifacts');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The card is drawn at A6; everything else is derived from that.
const ART_W = 105;
const ART_H = 148;

const A4_W = 210;
const A4_H = 297;
// Conservative: almost every inkjet and laser manages 8 mm.
const UNPRINTABLE_MM = 8;
const BLEED_MM = 3;

/**
 * Where the QR sends people.
 *
 * Deliberately the brand's own product page and NOT Amazon or Blinkit. Neither
 * listing exists yet, and a card asking for a review on a shop that is not there
 * is worse than a card that asks for nothing. The site's review flow requires a
 * delivered order against the signed-in customer, so this lands them exactly
 * where they can actually write one.
 */
const REVIEW_URL = 'https://mothersgoldspice.com/shop/mango-mustard-pickle';

const argv = process.argv.slice(2);
const flagValue = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const bleedMode = argv.includes('--bleed');
const only = flagValue('design');

// ─── QR ──────────────────────────────────────────────────────────────────────

/**
 * Replace the 22 × 22 mm slot each design reserves with a real QR.
 *
 * The design draws a plain <rect id="qr-slot" .../>; this reads its geometry and
 * swaps in QR modules as one <path>, so the code inherits the card's coordinate
 * system and stays vector — a rasterised QR at this size scans badly.
 */
async function injectQr(svg, url) {
  const slot = svg.match(/<rect[^>]*id="qr-slot"[^>]*\/?>/);
  if (!slot) return { svg, placed: false };

  const attr = (name) => {
    const m = slot[0].match(new RegExp(`${name}="([\\d.\\-]+)"`));
    return m ? Number.parseFloat(m[1]) : null;
  };
  const x = attr('x') ?? 0;
  const y = attr('y') ?? 0;
  const size = attr('width') ?? 22;

  // Level M: enough redundancy to survive a thumbprint, without so many modules
  // that each one goes sub-millimetre and a phone camera struggles.
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;

  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        d += `M${(x + c * cell).toFixed(3)} ${(y + r * cell).toFixed(3)}h${cell.toFixed(3)}v${cell.toFixed(3)}h-${cell.toFixed(3)}z`;
      }
    }
  }

  // Quiet zone matters: a QR butted against artwork often will not resolve.
  const quiet = `<rect x="${x - 1.5}" y="${y - 1.5}" width="${size + 3}" height="${size + 3}" fill="#fbf6ec"/>`;
  return { svg: svg.replace(slot[0], `${quiet}<path d="${d}" fill="#2a1a10" shape-rendering="crispEdges"/>`), placed: true, modules: n };
}

// ─── Sheet ───────────────────────────────────────────────────────────────────

function sheetHtml(cardSvg, { cardW, cardH, cols, rows, pageW, pageH, cropMarks }) {
  const inner = cardSvg
    .replace(/\swidth="[^"]*"/, ` width="${cardW}mm"`)
    .replace(/\sheight="[^"]*"/, ` height="${cardH}mm"`);

  const slots = Array.from({ length: cols * rows }, () => `
    <div class="slot">
      ${cropMarks ? '<span class="m tl"></span><span class="m tr"></span><span class="m bl"></span><span class="m br"></span>' : ''}
      ${inner}
    </div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Mother's Gold Spice — thank-you cards</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=Inter:wght@400;500;600&display=block" rel="stylesheet">
<style>
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${pageW}mm; height: ${pageH}mm; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${cardW}mm); gap: 0; }
  .slot { position: relative; width: ${cardW}mm; height: ${cardH}mm; }
  .slot svg { display: block; }
  /* Marks sit just outside each card so the blade never crosses printed area. */
  .m { position: absolute; width: 2.5mm; height: 2.5mm; }
  .m::before, .m::after { content: ''; position: absolute; background: rgba(42,26,16,0.55); }
  .m::before { width: 2.5mm; height: 0.15mm; }
  .m::after { width: 0.15mm; height: 2.5mm; }
  .tl { top: -3mm; left: -3mm; } .tl::before { bottom: 0; left: 0; } .tl::after { bottom: 0; left: 100%; }
  .tr { top: -3mm; right: -3mm; } .tr::before { bottom: 0; right: 0; } .tr::after { bottom: 0; right: 100%; }
  .bl { bottom: -3mm; left: -3mm; } .bl::before { top: 0; left: 0; } .bl::after { top: 0; left: 100%; }
  .br { bottom: -3mm; right: -3mm; } .br::before { top: 0; right: 0; } .br::after { top: 0; right: 100%; }
</style></head>
<body><div class="grid">${slots}</div></body></html>`;
}

// ─── Render ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(CARD_DIR)) {
  console.error(`No designs found at ${CARD_DIR}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const designs = fs
  .readdirSync(CARD_DIR)
  .filter((f) => f.endsWith('.svg'))
  .filter((f) => !only || f.includes(only));

if (designs.length === 0) {
  console.error(`No design matched "${only}". Available: ${fs.readdirSync(CARD_DIR).join(', ')}`);
  process.exit(1);
}

for (const file of designs) {
  const name = path.basename(file, '.svg');
  const raw = fs.readFileSync(path.join(CARD_DIR, file), 'utf8');
  const { svg, placed, modules } = await injectQr(raw, REVIEW_URL);

  const layout = bleedMode
    ? {
        // One card, true A6, with bleed all round for a trimming print shop.
        cardW: ART_W + 2 * BLEED_MM,
        cardH: ART_H + 2 * BLEED_MM,
        cols: 1, rows: 1,
        pageW: ART_W + 2 * BLEED_MM + 20,
        pageH: ART_H + 2 * BLEED_MM + 20,
        cropMarks: true,
      }
    : (() => {
        const printableW = A4_W - 2 * UNPRINTABLE_MM;
        const printableH = A4_H - 2 * UNPRINTABLE_MM;
        // Sized to the printable area, then held to the A6 aspect so the design
        // is never stretched — whichever dimension binds, wins.
        const byW = printableW / 2;
        const byH = printableH / 2;
        const scale = Math.min(byW / ART_W, byH / ART_H);
        return {
          cardW: +(ART_W * scale).toFixed(2),
          cardH: +(ART_H * scale).toFixed(2),
          cols: 2, rows: 2,
          pageW: A4_W, pageH: A4_H,
          cropMarks: true,
        };
      })();

  const stem = bleedMode ? `card-${name}-a6-bleed` : `card-${name}-4up`;
  const htmlPath = path.join(OUT_DIR, `${stem}.html`);
  const pdfPath = path.join(OUT_DIR, `${stem}.pdf`);
  fs.writeFileSync(htmlPath, sheetHtml(svg, layout));

  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found; HTML at ${htmlPath}`);
    continue;
  }
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-pdf-header-footer',
    '--virtual-time-budget=20000',
    `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const kb = (fs.statSync(pdfPath).size / 1024).toFixed(0);
  console.log(
    `  ${name.padEnd(10)} ${layout.cardW} × ${layout.cardH} mm · ${layout.cols * layout.rows} per sheet` +
      ` · QR ${placed ? `${modules}×${modules}` : 'NO SLOT FOUND'} · ${kb} KB`,
  );
  console.log(`    ${pdfPath}`);
}
