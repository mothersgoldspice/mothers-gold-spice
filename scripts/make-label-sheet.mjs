#!/usr/bin/env node
/**
 * Build a printable A4 sheet of wraparound labels, as a PDF.
 *
 *   node scripts/make-label-sheet.mjs            # 5-up A4, ready to print
 *   node scripts/make-label-sheet.mjs --per-page 3
 *   node scripts/make-label-sheet.mjs --single   # one label, for a print shop
 *
 * The artwork is READ OUT of src/pages/label-preview.astro rather than copied.
 * That file is where the label is actually designed and what the 3D preview
 * renders, so a copy here would silently go stale the first time the design
 * changed and nobody would notice until a batch had been printed.
 *
 * ─── On the size ─────────────────────────────────────────────────────────────
 *
 * The artwork is drawn 1440 × 360, a 4:1 ratio. The jar is 63 mm across, so its
 * circumference is 198 mm and a wraparound label can be at most that wide.
 * At 190 mm wide the artwork is therefore 47.5 mm tall.
 *
 * LABEL.md §"Label height" says 70 mm. That is not achievable with this artwork:
 * 70 mm tall at 4:1 would need a 280 mm width, and there is only 198 mm of jar.
 * Printing it at 70 mm anyway would stretch every letterform by 47%. So this
 * script prints at the artwork's true aspect and leaves the discrepancy visible
 * rather than resolving it by distorting the type — see the note it prints.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src/pages/label-preview.astro');
const OUT_DIR = path.join(ROOT, 'artifacts');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ─── Args (read first: the page maths depends on them) ───────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const single = argv.includes('--single');
// The proof warning is worth a label per sheet while the FSSAI number, MRP and
// batch code are still invented. Once they are real it is just wasted paper —
// 25 sheets per 100 jars instead of 20 — so it can be dropped deliberately.
const noProof = argv.includes('--no-proof');

// ─── Physical spec ───────────────────────────────────────────────────────────

const JAR_DIAMETER_MM = 63;
const LABEL_W_MM = 190;            // LABEL.md: circumference less a glue overlap
const ART_W = 1440;                // artwork viewBox
const ART_H = 360;
const LABEL_H_MM = +((LABEL_W_MM * ART_H) / ART_W).toFixed(2);   // 47.5

// A4, with a margin every consumer printer can manage.
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const MARGIN_MM = 8;
const GAP_MM = 3;
// The footer carries the calibration ruler, which is the whole point of it — so
// its height is reserved BEFORE deciding how many labels fit. Sizing the labels
// first pushed the ruler onto a second page, where it is useless: you cannot
// check the scale of page 1 with a ruler printed on page 2.
// Measured, not guessed: two lines of spec, two lines of print instruction, the
// four-field proof warning, and the ruler. Reserving too little is what put the
// ruler on page two the first time round.
const FOOTER_MM = noProof ? 26 : 40;

const usableH = PAGE_H_MM - 2 * MARGIN_MM - FOOTER_MM;
const maxPerPage = Math.floor((usableH + GAP_MM) / (LABEL_H_MM + GAP_MM));
const perPage = single ? 1 : Math.min(Number.parseInt(flag('per-page', String(maxPerPage)), 10) || maxPerPage, maxPerPage);

// ─── Pull the artwork out of the page that owns it ───────────────────────────

function extractLabelSvg() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const match = src.match(/const labelSvg = `([\s\S]*?)`;\n/);
  if (!match) {
    throw new Error(`Could not find "const labelSvg = \`...\`" in ${SOURCE}. Was it renamed?`);
  }
  const svg = match[1].trim();
  if (svg.includes('${')) {
    // A template literal with interpolation would need the page's runtime state,
    // which this script does not have. Better to stop than to print `${x}`.
    throw new Error('The label SVG now contains a ${...} interpolation; this script can only take it verbatim.');
  }
  return svg;
}

/** Size the SVG in millimetres; the viewBox does the scaling. */
function sizedSvg(svg) {
  return svg
    .replace(/\swidth="\d+"/, ` width="${LABEL_W_MM}mm"`)
    .replace(/\sheight="\d+"/, ` height="${LABEL_H_MM}mm"`);
}

// ─── Sheet ───────────────────────────────────────────────────────────────────

function buildHtml(svg) {
  const one = sizedSvg(svg);
  const labels = Array.from({ length: perPage }, () => `
      <div class="slot">
        <span class="mark tl"></span><span class="mark tr"></span>
        <span class="mark bl"></span><span class="mark br"></span>
        ${one}
      </div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mother's Gold Spice — label print sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700&display=block" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${PAGE_W_MM}mm;
    /* Pinned to exactly one sheet. Without a fixed height Chrome will spill a
       millimetre of rounding onto a second page, and a second page here is not a
       harmless blank — it is the calibration ruler, separated from the labels it
       is supposed to calibrate. */
    height: ${PAGE_H_MM}mm;
    overflow: hidden;
    padding: ${MARGIN_MM}mm;
    display: flex;
    flex-direction: column;
    font-family: 'Inter', system-ui, sans-serif;
    color: #2a1a10;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .slot {
    position: relative;
    width: ${LABEL_W_MM}mm;
    height: ${LABEL_H_MM}mm;
    margin: 0 auto ${GAP_MM}mm;
  }
  .slot:last-of-type { margin-bottom: 0; }
  .slot svg { display: block; }

  /* Crop marks sit OUTSIDE the artwork so the blade never crosses printed area. */
  .mark { position: absolute; width: 3mm; height: 3mm; }
  .mark::before, .mark::after {
    content: ''; position: absolute; background: #2a1a10;
  }
  .mark::before { width: 3mm; height: 0.2mm; top: 0; }
  .mark::after  { width: 0.2mm; height: 3mm; left: 0; }
  .tl { top: -3.6mm; left: -3.6mm; } .tl::before { bottom: 0; left: 0; } .tl::after { bottom: 0; left: 100%; }
  .tr { top: -3.6mm; right: -3.6mm; } .tr::before { bottom: 0; right: 0; } .tr::after { bottom: 0; right: 100%; }
  .bl { bottom: -3.6mm; left: -3.6mm; } .bl::before { top: 0; left: 0; } .bl::after { top: 0; left: 100%; }
  .br { bottom: -3.6mm; right: -3.6mm; } .br::before { top: 0; right: 0; } .br::after { top: 0; right: 100%; }

  footer {
    margin-top: auto;
    padding-top: 2.5mm;
    border-top: 0.2mm solid rgba(42,26,16,0.25);
    font-size: 7.5pt;
    line-height: 1.5;
    color: rgba(42,26,16,0.75);
  }
  footer b { color: #7a1f10; }
  /* Sits below the cut line, so it is on the sheet and never on a jar. A printed
     proof outlives the conversation that produced it; the caveat has to travel
     with the paper. */
  .warn {
    margin-top: 2mm;
    padding: 1.8mm 2.2mm;
    border: 0.3mm solid #7a1f10;
    border-radius: 1mm;
    background: #fdf3ef;
    color: #7a1f10;
  }
  .ruler { margin-top: 2mm; position: relative; height: 7mm; }
  .ruler .bar { position: absolute; top: 0; left: 0; width: 100mm; height: 3mm; border: 0.2mm solid #2a1a10; border-top: none; }
  .ruler .tick { position: absolute; top: 0; width: 0.2mm; height: 2mm; background: #2a1a10; }
  .ruler .cap  { position: absolute; top: 3.6mm; font-size: 6.5pt; transform: translateX(-50%); }
</style>
</head>
<body>
${labels}
  <footer>
    <div><b>Mother's Gold Spice</b> — wraparound label, ${LABEL_W_MM} × ${LABEL_H_MM} mm, ${perPage} per A4 sheet.
    Jar ${JAR_DIAMETER_MM} mm diameter (${(Math.PI * JAR_DIAMETER_MM).toFixed(0)} mm circumference), so ${LABEL_W_MM} mm wraps with a ${(Math.PI * JAR_DIAMETER_MM - LABEL_W_MM).toFixed(0)} mm overlap for the glue strip.</div>
    <div style="margin-top:1.5mm"><b>Print at 100% — do not "fit to page".</b> Then check the bar below measures exactly 100 mm. If it does not, the printer scaled the sheet and the labels will not wrap.</div>
    ${noProof ? '' : `<div class="warn"><b>PROOF ONLY — four fields are placeholders and must be corrected before any jar is sold:</b>
      FSSAI <b>10012345000123</b> is invented and no licence has been issued yet (printing a fabricated licence number is an offence under the FSS Act) ·
      MRP <b>₹449</b> but the shop sells this size at <b>₹299</b> ·
      batch <b>MGS-2026-04-001</b> and <b>04/2026–04/2027</b> are examples, not this batch.</div>`}
    <div class="ruler">
      <div class="bar"></div>
      ${[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((mm) => `<span class="tick" style="left:${mm}mm"></span>`).join('')}
      <span class="cap" style="left:0mm">0</span>
      <span class="cap" style="left:50mm">50 mm</span>
      <span class="cap" style="left:100mm">100</span>
    </div>
  </footer>
</body>
</html>`;
}

// ─── Render ──────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });
const stem = single ? 'label-single' : `label-sheet-${perPage}up`;
const htmlPath = path.join(OUT_DIR, `${stem}.html`);
const pdfPath = path.join(OUT_DIR, `${stem}.pdf`);

const svg = extractLabelSvg();
fs.writeFileSync(htmlPath, buildHtml(svg));

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. The HTML sheet is still at:\n  ${htmlPath}\nOpen it and print to PDF from the browser.`);
  process.exit(1);
}

execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    // Google Fonts are fetched over the network; without a virtual time budget
    // Chrome snapshots the page before they land and the label prints in Times.
    '--virtual-time-budget=20000',
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

const bytes = fs.statSync(pdfPath).size;
console.log(`  ${perPage} label${perPage === 1 ? '' : 's'} per A4 sheet`);
console.log(`  each ${LABEL_W_MM} × ${LABEL_H_MM} mm`);
console.log(`  ${pdfPath}  (${(bytes / 1024).toFixed(0)} KB)`);
if (!single) {
  console.log(`\n  Sheets needed: 1 per ${perPage} jars. A 100-jar batch is ${Math.ceil(100 / perPage)} sheets.`);
}
console.log(
  `\n  NOTE: LABEL.md gives the height as 70 mm. This artwork is 4:1, so at ${LABEL_W_MM} mm wide it is`,
  `\n  ${LABEL_H_MM} mm tall. Reaching 70 mm would need a 280 mm width and the jar is only`,
  `${(Math.PI * JAR_DIAMETER_MM).toFixed(0)} mm around.`,
  `\n  Either accept ${LABEL_H_MM} mm, or redraw the artwork taller — do not scale it to fit.`,
);
