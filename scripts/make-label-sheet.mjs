#!/usr/bin/env node
/**
 * Build printable A4 sheets of wraparound labels, as PDFs.
 *
 *   node scripts/make-label-sheet.mjs              # every jar, proof sheets
 *   node scripts/make-label-sheet.mjs --jar 400    # one jar only
 *   node scripts/make-label-sheet.mjs --single     # one label, for a print shop
 *   node scripts/make-label-sheet.mjs --no-proof   # drop the warning, fit more
 *
 * The artwork is READ OUT of src/pages/label-preview.astro rather than copied.
 * That file is where the label is designed and what the 3D preview renders, so a
 * copy here would go stale the first time the design changed and nobody would
 * find out until a batch had been printed.
 *
 * ─── Why the height is what it is ────────────────────────────────────────────
 *
 * The artwork is drawn 1440 × 360, a 4:1 ratio, and a wraparound label can be at
 * most the jar's circumference wide. The height therefore follows from the
 * diameter and is not a free choice. LABEL.md's "70 mm" is unreachable on the
 * 63 mm jar — it would need 280 mm of width against 198 mm of circumference, and
 * forcing it would stretch every letterform by 47%.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src/pages/label-preview.astro');
const OUT_DIR = path.join(ROOT, 'artifacts');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ART_W = 1440;
const ART_H = 360;
const GLUE_OVERLAP_MM = 8;   // the strip that laps under itself on the jar

// ─── Jars ────────────────────────────────────────────────────────────────────

/**
 * `bodyMm` is the measurement everything else falls out of: it sets the wrap,
 * hence the label width, hence (at 4:1) the height.
 *
 * `assumed` lists what nobody has confirmed. It prints ON THE SHEET, not just in
 * the terminal, because a proof outlives the session that produced it.
 */
const JARS = {
  250: {
    id: '250',
    name: '250 g jar',
    bodyMm: 63,                 // PACKAGING.md §1: body diameter ~63–66 mm
    netWt: '250g',
    mrp: '₹449',
    assumed: [],
  },
  400: {
    id: '400',
    name: '400 mL jar',
    // NOT in PACKAGING.md — that spec covers only the 250 g jar. 73 mm is the
    // usual body for a 400 mL round jar that keeps the same GPI 63/2030 neck,
    // which is worth keeping: cap, EPE liner and induction foil stay identical
    // and only the glass and the label change.
    bodyMm: 73,
    // 400 mL brim less the 10% headspace the 250 g spec assumes is 360 mL, and
    // pickle in mustard oil runs 1.10–1.20 g/mL — so about 400 g, NOT 500 g.
    netWt: '400g',
    mrp: '₹499',
    assumed: [
      'body diameter 73 mm is typical for a 400 mL jar but has NOT been measured — it sets the label width, so confirm it with the factory before printing a batch',
      'net 400g is calculated from 400 mL brim less 10% headspace at 1.1 g/mL — weigh a filled jar to confirm',
      'the shop lists this size as "500 g" at ₹499, but a 400 mL jar does not hold 500 g — either the jar or the listing has to change',
    ],
  },
};

// ─── Args (read first: the page maths depends on them) ───────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const single = argv.includes('--single');
// The proof warning is worth a label per sheet while the FSSAI number and batch
// code are invented. Once they are real it is just wasted paper.
const noProof = argv.includes('--no-proof');
const only = flag('jar', null);

// ─── Page ────────────────────────────────────────────────────────────────────

const A4_SHORT = 210;
const A4_LONG = 297;
const MARGIN_MM = 8;
const GAP_MM = 3;
const FOOTER_MM = noProof ? 26 : 46;

/**
 * Pick the layout that gets the most labels onto one sheet.
 *
 * Four candidates: portrait or landscape, label upright or turned 90°. The
 * 400 mL label is 221 mm wide and does not fit across A4 upright at all — turned
 * on its side, three fit down the page. Trying all four is the difference
 * between two labels a sheet and three, which over 100 jars is 34 sheets or 17.
 */
function bestLayout(labelW, labelH) {
  const options = [];
  for (const [orientation, pw, ph] of [['portrait', A4_SHORT, A4_LONG], ['landscape', A4_LONG, A4_SHORT]]) {
    for (const rotated of [false, true]) {
      const w = rotated ? labelH : labelW;
      const h = rotated ? labelW : labelH;
      const usableW = pw - 2 * MARGIN_MM;
      const usableH = ph - 2 * MARGIN_MM - FOOTER_MM;
      if (w > usableW || h > usableH) continue;
      const cols = Math.floor((usableW + GAP_MM) / (w + GAP_MM));
      const rows = Math.floor((usableH + GAP_MM) / (h + GAP_MM));
      if (cols < 1 || rows < 1) continue;
      options.push({ orientation, rotated, cols, rows, perPage: cols * rows, pw, ph, w, h });
    }
  }
  if (options.length === 0) return null;
  // Most per sheet; upright breaks ties, being easier to cut square.
  options.sort((a, b) => b.perPage - a.perPage || Number(a.rotated) - Number(b.rotated));
  return options[0];
}

// ─── Artwork ─────────────────────────────────────────────────────────────────

function extractLabelSvg() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const match = src.match(/const labelSvg = `([\s\S]*?)`;\n/);
  if (!match) throw new Error(`Could not find "const labelSvg = \`...\`" in ${SOURCE}. Was it renamed?`);
  const svg = match[1].trim();
  if (svg.includes('${')) {
    throw new Error('The label SVG now contains a ${...} interpolation; this script can only take it verbatim.');
  }
  return svg;
}

/**
 * Swap the net weight and MRP for this jar.
 *
 * The artwork hardcodes "250g" and "₹449" inside the SVG — the page's own
 * `netWt` variable feeds only its HTML mockup, not the vector. Matched as whole
 * text nodes so a stray "250g" elsewhere could never be rewritten by accident,
 * and a miss throws rather than silently printing the wrong weight on a jar.
 */
function personalise(svg, jar) {
  let out = svg;
  for (const [re, to] of [
    [/(>)250g(<\/text>)/, `$1${jar.netWt}$2`],
    [/(>)₹449(<\/text>)/, `$1${jar.mrp}$2`],
  ]) {
    if (!re.test(out)) throw new Error(`Could not find the text node for ${re} — has the artwork changed?`);
    out = out.replace(re, to);
  }
  return out;
}

const sizedSvg = (svg, wMm, hMm) =>
  svg.replace(/\swidth="\d+"/, ` width="${wMm}mm"`).replace(/\sheight="\d+"/, ` height="${hMm}mm"`);

// ─── Sheet ───────────────────────────────────────────────────────────────────

function buildHtml(svg, jar, geom, layout, perPage) {
  const art = sizedSvg(personalise(svg, jar), geom.labelW, geom.labelH);
  const slots = Array.from({ length: perPage }, () => `
      <div class="slot">
        <span class="mark tl"></span><span class="mark tr"></span>
        <span class="mark bl"></span><span class="mark br"></span>
        <div class="art">${art}</div>
      </div>`).join('');

  const assumedHtml = jar.assumed.length === 0 ? '' : `
    <div class="warn"><b>UNCONFIRMED for the ${jar.name} — settle these before printing a batch:</b>
      ${jar.assumed.map((a) => `<div>· ${a}</div>`).join('')}</div>`;

  const proofHtml = noProof ? '' : `
    <div class="warn"><b>PROOF ONLY — placeholders to correct before any jar is sold:</b>
      FSSAI <b>10012345000123</b> is invented and no licence has been issued yet (printing a fabricated
      licence number is an offence under the FSS Act) · batch <b>MGS-2026-04-001</b> and
      <b>04/2026–04/2027</b> are examples, not this batch.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mother's Gold Spice — ${jar.name} label sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700&display=block" rel="stylesheet">
<style>
  @page { size: A4 ${layout.orientation}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${layout.pw}mm;
    /* Pinned to one sheet. Without a fixed height Chrome spills a millimetre of
       rounding onto a second page — and page two is the calibration ruler,
       separated from the labels it exists to check. */
    height: ${layout.ph}mm;
    overflow: hidden;
    padding: ${MARGIN_MM}mm;
    display: flex;
    flex-direction: column;
    font-family: 'Inter', system-ui, sans-serif;
    color: #2a1a10;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(${layout.cols}, ${layout.w}mm);
    gap: ${GAP_MM}mm;
    justify-content: center;
  }
  .slot { position: relative; width: ${layout.w}mm; height: ${layout.h}mm; }
  .art {
    position: absolute; top: 0; left: 0;
    width: ${geom.labelW}mm; height: ${geom.labelH}mm;
    ${layout.rotated ? `transform: translateX(${layout.w}mm) rotate(90deg); transform-origin: 0 0;` : ''}
  }
  .art svg { display: block; }

  /* Crop marks sit OUTSIDE the artwork so the blade never crosses printed area. */
  .mark { position: absolute; width: 3mm; height: 3mm; }
  .mark::before, .mark::after { content: ''; position: absolute; background: #2a1a10; }
  .mark::before { width: 3mm; height: 0.2mm; }
  .mark::after  { width: 0.2mm; height: 3mm; }
  .tl { top: -3.6mm; left: -3.6mm; } .tl::before { bottom: 0; left: 0; } .tl::after { bottom: 0; left: 100%; }
  .tr { top: -3.6mm; right: -3.6mm; } .tr::before { bottom: 0; right: 0; } .tr::after { bottom: 0; right: 100%; }
  .bl { bottom: -3.6mm; left: -3.6mm; } .bl::before { top: 0; left: 0; } .bl::after { top: 0; left: 100%; }
  .br { bottom: -3.6mm; right: -3.6mm; } .br::before { top: 0; right: 0; } .br::after { top: 0; right: 100%; }

  footer {
    margin-top: auto; padding-top: 2.5mm;
    border-top: 0.2mm solid rgba(42,26,16,0.25);
    font-size: 7pt; line-height: 1.45; color: rgba(42,26,16,0.75);
  }
  footer b { color: #7a1f10; }
  .warn {
    margin-top: 1.6mm; padding: 1.5mm 2mm;
    border: 0.3mm solid #7a1f10; border-radius: 1mm;
    background: #fdf3ef; color: #7a1f10;
  }
  .ruler { margin-top: 1.6mm; position: relative; height: 6.5mm; }
  .ruler .bar { position: absolute; top: 0; left: 0; width: 100mm; height: 2.6mm; border: 0.2mm solid #2a1a10; border-top: none; }
  .ruler .tick { position: absolute; top: 0; width: 0.2mm; height: 1.8mm; background: #2a1a10; }
  .ruler .cap { position: absolute; top: 3.2mm; font-size: 6pt; transform: translateX(-50%); }
</style>
</head>
<body>
  <div class="grid">${slots}</div>
  <footer>
    <div><b>Mother's Gold Spice — ${jar.name}.</b> Wraparound label ${geom.labelW} × ${geom.labelH} mm,
      ${perPage} per A4 ${layout.orientation}${layout.rotated ? ' (turned 90°)' : ''}.
      Jar ${jar.bodyMm} mm across = ${geom.circumference} mm around, wrapping with a ${GLUE_OVERLAP_MM} mm glue overlap.
      Net ${jar.netWt} · MRP ${jar.mrp}.</div>
    <div style="margin-top:1.2mm"><b>Print at 100% — do not "fit to page".</b> Check the bar below measures exactly 100 mm; if it does not, the sheet was scaled and the labels will not meet round the jar.</div>
    ${assumedHtml}${proofHtml}
    <div class="ruler">
      <div class="bar"></div>
      ${[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((mm) => `<span class="tick" style="left:${mm}mm"></span>`).join('')}
      <span class="cap" style="left:0mm">0</span><span class="cap" style="left:50mm">50 mm</span><span class="cap" style="left:100mm">100</span>
    </div>
  </footer>
</body>
</html>`;
}

// ─── Render ──────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });
const svg = extractLabelSvg();
const chosen = only ? [JARS[only]].filter(Boolean) : Object.values(JARS);
if (chosen.length === 0) {
  console.error(`Unknown jar "${only}". Known: ${Object.keys(JARS).join(', ')}`);
  process.exit(2);
}

for (const jar of chosen) {
  const circumference = +(Math.PI * jar.bodyMm).toFixed(1);
  const labelW = +(circumference - GLUE_OVERLAP_MM).toFixed(1);
  const labelH = +((labelW * ART_H) / ART_W).toFixed(2);
  const geom = { circumference, labelW, labelH };

  const layout = bestLayout(labelW, labelH);
  if (!layout) {
    console.error(`  ${jar.name}: ${labelW} × ${labelH} mm does not fit on A4 in any orientation.`);
    continue;
  }
  const perPage = single ? 1 : layout.perPage;
  const effective = single ? { ...layout, cols: 1, rows: 1 } : layout;

  const stem = single ? `label-${jar.id}-single` : `label-${jar.id}-${perPage}up`;
  const htmlPath = path.join(OUT_DIR, `${stem}.html`);
  const pdfPath = path.join(OUT_DIR, `${stem}.pdf`);
  fs.writeFileSync(htmlPath, buildHtml(svg, jar, geom, effective, perPage));

  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}; HTML written to ${htmlPath}`);
    continue;
  }
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-pdf-header-footer',
    // Google Fonts arrive over the network; without a budget Chrome snapshots
    // the page first and the label prints in Times.
    '--virtual-time-budget=20000',
    `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const kb = (fs.statSync(pdfPath).size / 1024).toFixed(0);
  console.log(`  ${jar.name}: ${labelW} × ${labelH} mm · ${perPage} per A4 ${effective.orientation}${effective.rotated ? ' (turned 90°)' : ''} · ${kb} KB`);
  console.log(`    ${pdfPath}`);
  if (!single) console.log(`    100 jars = ${Math.ceil(100 / perPage)} sheets`);
  for (const a of jar.assumed) console.log(`    ASSUMED: ${a}`);
}
