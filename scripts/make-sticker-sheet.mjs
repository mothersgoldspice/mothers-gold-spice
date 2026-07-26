#!/usr/bin/env node
/**
 * Compose the individual sticker designs onto one kiss-cut A6 sheet, and render
 * it to PDF alongside a 4-up A4 gang sheet.
 *
 *   node scripts/make-sticker-sheet.mjs
 *
 * ─── Why a sheet and not loose die-cuts ──────────────────────────────────────
 *
 * Individually die-cut stickers are quoted per shape and per cut; a kiss-cut
 * sheet is quoted as one printed piece with one cut file, so six stickers on a
 * sheet lands close to the price of one loose die-cut at the volumes a first
 * batch involves. It also arrives flat next to the thank-you card instead of
 * loose in the box, which is the difference between a gift and something that
 * fell in.
 *
 * ─── The cut line ────────────────────────────────────────────────────────────
 *
 * The dashed outlines here are a GUIDE, drawn in ink so they are visible when
 * cutting by hand. A print shop with a plotter needs the cut path as a separate
 * spot colour — usually named CutContour — on its own layer, which this script
 * emits as a `<g id="cutcontour">` they can isolate. Say that when you send it,
 * or they will print the dashes as artwork.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'artifacts/stickers');
const OUT_DIR = path.join(ROOT, 'artifacts');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SHEET_W = 105;   // A6
const SHEET_H = 148;
const MARGIN = 8;

/**
 * Placements, in sheet millimetres.
 *
 * The barni appears twice on purpose: three circular designs is an odd number
 * that leaves a hole in a two-column grid, and a spare of the most giftable one
 * is more use than whitespace — people put one on a laptop and lose the other.
 */
const PLACEMENTS = [
  { file: 'sticker-barni.svg', x: 9, y: 10, w: 42, h: 42, shape: 'circle' },
  { file: 'sticker-claim.svg', x: 54, y: 10, w: 42, h: 42, shape: 'circle' },
  { file: 'sticker-roundel.svg', x: 9, y: 56, w: 42, h: 42, shape: 'circle' },
  { file: 'sticker-barni.svg', x: 54, y: 56, w: 42, h: 42, shape: 'circle' },
  // One artboard holding two badges side by side; the cut line is per badge.
  { file: 'sticker-badges.svg', x: 8.5, y: 102, w: 88, h: 26, shape: 'badges' },
];

/** Strip the outer <svg> wrapper so the contents can be placed in a group. */
function inner(svgText) {
  const open = svgText.indexOf('>', svgText.indexOf('<svg'));
  const close = svgText.lastIndexOf('</svg>');
  if (open < 0 || close < 0) throw new Error('Malformed SVG');
  return svgText.slice(open + 1, close);
}

function cutPathFor(p) {
  if (p.shape === 'circle') {
    return `<circle cx="${p.x + p.w / 2}" cy="${p.y + p.h / 2}" r="${p.w / 2}" />`;
  }
  // Two badges, 42 wide each with a 4mm gutter, matching the badge artboard.
  return [0, 46]
    .map((dx) => `<rect x="${p.x + dx}" y="${p.y}" width="42" height="26" rx="4" />`)
    .join('');
}

function buildSheet() {
  const bodies = [];
  const cuts = [];

  for (const p of PLACEMENTS) {
    const file = path.join(SRC, p.file);
    if (!fs.existsSync(file)) throw new Error(`Missing design: ${file}`);
    const raw = fs.readFileSync(file, 'utf8');

    // Each design is authored on its own artboard in mm, so a translate is all
    // that is needed — no scaling, which would thin the line weights the
    // designs were tuned for.
    bodies.push(`<g transform="translate(${p.x} ${p.y})">${inner(raw)}</g>`);
    cuts.push(cutPathFor(p));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET_W} ${SHEET_H}" width="${SHEET_W}mm" height="${SHEET_H}mm">
  <rect width="${SHEET_W}" height="${SHEET_H}" fill="#fbf6ec"/>
  ${bodies.join('\n  ')}
  <!-- Cut path. A plotter needs this isolated as a CutContour spot colour;
       printed as-is it is a guide for scissors. -->
  <g id="cutcontour" fill="none" stroke="#2a1a10" stroke-opacity="0.35" stroke-width="0.25" stroke-dasharray="1.6 1.4">
    ${cuts.join('\n    ')}
  </g>
  <text x="${SHEET_W / 2}" y="${SHEET_H - 5}" text-anchor="middle" font-family="'Inter', sans-serif"
        font-size="2.6" fill="#2a1a10" fill-opacity="0.45">Mother's Gold Spice · cut along the dashed lines</text>
</svg>`;
}

function pageHtml(sheetSvg, { cols, rows, pageW, pageH, cardW, cardH }) {
  const scaled = sheetSvg
    .replace(/\swidth="[^"]*"/, ` width="${cardW}mm"`)
    .replace(/\sheight="[^"]*"/, ` height="${cardH}mm"`);
  const slots = Array.from({ length: cols * rows }, () => `<div class="slot">${scaled}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700&family=Inter:wght@400;500;600;700&display=block" rel="stylesheet">
<style>
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  *{box-sizing:border-box} html,body{margin:0;padding:0}
  body{width:${pageW}mm;height:${pageH}mm;overflow:hidden;display:flex;align-items:center;justify-content:center;
       -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .grid{display:grid;grid-template-columns:repeat(${cols}, ${cardW}mm);gap:0}
  .slot{width:${cardW}mm;height:${cardH}mm}
  .slot svg{display:block}
</style></head><body><div class="grid">${slots}</div></body></html>`;
}

// ─── Render ──────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });
const sheet = buildSheet();
fs.writeFileSync(path.join(SRC, 'sheet-a6.svg'), sheet);

const targets = [
  { stem: 'stickers-a6', cols: 1, rows: 1, pageW: SHEET_W, pageH: SHEET_H, cardW: SHEET_W, cardH: SHEET_H },
  // 4-up sized to the printable area, same reasoning as the card sheet: a cream
  // background with an unprinted sliver down one edge reads as a misprint.
  { stem: 'stickers-4up-a4', cols: 2, rows: 2, pageW: 210, pageH: 297, cardW: 97, cardH: 136.72 },
];

for (const t of targets) {
  const htmlPath = path.join(OUT_DIR, `${t.stem}.html`);
  const pdfPath = path.join(OUT_DIR, `${t.stem}.pdf`);
  fs.writeFileSync(htmlPath, pageHtml(sheet, t));
  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found; HTML at ${htmlPath}`);
    continue;
  }
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-pdf-header-footer',
    '--virtual-time-budget=20000', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kb = (fs.statSync(pdfPath).size / 1024).toFixed(0);
  console.log(`  ${t.stem.padEnd(16)} ${t.cols * t.rows} sheet(s) per page · ${PLACEMENTS.length * t.cols * t.rows} stickers · ${kb} KB`);
  console.log(`    ${pdfPath}`);
}
