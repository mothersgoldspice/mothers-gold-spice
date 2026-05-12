# Label Design Spec — Mother's Gold Spice

Indian packaged-food labels are legally regulated. This doc captures every mandatory element + our brand-specific copy.

**Legal source:** FSSAI's *Food Safety and Standards (Labelling and Display) Regulations, 2020* + *Legal Metrology (Packaged Commodities) Rules, 2011*.

> Visual preview lives at **[/label-preview](https://mothersgoldspice.com/label-preview)** on the site. Update copy in this doc, then sync the preview page.

---

## 1. Mandatory elements (FSSAI + Legal Metrology)

Every retail pack must show **all** of these, regardless of size:

| # | Element | Notes |
|---|---------|-------|
| 1 | **Brand name** | "Mother's Gold Spice" |
| 2 | **Product common name** | "Mango Pickle" (the common name, not a fancy invented one) |
| 3 | **Veg/Non-veg symbol** | Filled green circle inside green square outline (mandatory). Brown for non-veg. Position must be prominent on the principal display panel. |
| 4 | **List of ingredients** | In **descending order by weight**, including category names of additives (e.g., "Acidulant — Citric Acid"). No additives in our recipe = simpler list. |
| 5 | **Allergen declaration** | Mustard is a major allergen — declare "Contains Mustard". |
| 6 | **Net quantity** | In grams, lower-case "g", with the small "e" mark *only if* we've done legal pack-weight verification (skip "e" unless verified). |
| 7 | **Nutritional information** | Per 100g: Energy (kcal), Protein, Carbohydrates (of which sugars), Total Fat (of which saturated, trans), Sodium. Mandatory layout — table form. |
| 8 | **Manufacturer name and full address** | Including PIN code. If marketer ≠ manufacturer, both must appear. |
| 9 | **Country of origin** | "Made in India" / "Product of India". |
| 10 | **FSSAI logo + license number** | License number in the specified format, displayed alongside the FSSAI logo. Mandatory size: license number height ≥ 3 mm. |
| 11 | **Date of manufacture** | DD/MM/YYYY or MMM YYYY. |
| 12 | **Best before / Use by date** | "Best before 12 months from packaging" OR a specific date. |
| 13 | **Batch / Lot / Code number** | Any traceable identifier (e.g., `BATCH-2026-04-001`). |
| 14 | **MRP** | "MRP ₹___ (inclusive of all taxes)" — mandatory under Legal Metrology. |
| 15 | **Storage instructions** | "Store in a cool, dry place. Refrigerate after opening. Use a clean, dry spoon." |
| 16 | **Consumer care contact** | Email and/or phone. We'll use `mothersgoldspice@gmail.com` until we have a customer service number. |

### Optional but recommended

- "**No Preservatives | No Additives**" claim — only if literally true (it is for us; keep it that way).
- **Net quantity** in *both* grams and ounces if selling internationally.
- **Vegan symbol** — useful for D2C / export. Not legally required.
- **GMO-free** claim — only if certified.
- **Organic** claim — **legally restricted**: requires certification under the Jaivik Bharat / FSSAI organic regulations. Don't claim "organic" unless certified.

### Forbidden / risky claims

- "100% pure" — generic puffery, can attract notices.
- "Mother-recipe" / "Home-made" — acceptable as brand storytelling, but the **label must say "Hand-made in small batches"**, not "home-made", because legally you'll be manufacturing in a licensed kitchen, not a domestic home. Safer phrasing.
- "Cures" / "Healthy" / specific health claims — regulated and require scientific substantiation. Avoid.

---

## 2. Label copy — Mango Pickle (SKU 1)

This is the actual text that goes on the label.

### Front panel (principal display)

```
HAND-MADE IN BANGALORE  · SMALL BATCH

Mother's Gold Spice
————————————

Mango Pickle
in Mustard Oil

NO PRESERVATIVES  ·  NO ADDITIVES

NET WT. 250g          [VEG SYMBOL]
```

### Back panel (info side)

```
INGREDIENTS
Raw Mango (60%), Mustard Oil (25%), Salt, Spices
(Mustard Seeds, Fenugreek, Red Chilli, Turmeric,
Asafoetida).

ALLERGEN INFORMATION
Contains Mustard.

NUTRITIONAL INFORMATION (per 100g, approx.)
Energy ........................... ___ kcal
Protein .......................... ___ g
Carbohydrates .................... ___ g
   of which sugars ............... ___ g
Total Fat ........................ ___ g
   of which saturated fat ........ ___ g
   of which trans fat ............ 0 g
Sodium ........................... ___ mg

STORAGE
Store in a cool, dry place away from direct
sunlight. Refrigerate after opening. Always use
a clean, dry spoon. Oil naturally separates —
this is normal.

SHELF LIFE
12 months from date of manufacture, unopened.

FSSAI Lic. No.  [______________]
Batch No.       [______________]
Mfg. Date       [DD/MM/YYYY]
Best Before     [DD/MM/YYYY]

MRP ₹___ (inclusive of all taxes)

MANUFACTURED & MARKETED BY
Mother's Gold Spice
[Full address with PIN]
Bangalore, Karnataka — [PIN]
India

CONSUMER CARE
mothersgoldspice@gmail.com

Made in India.
```

**`___` placeholders** are filled in per batch (manually on a sticker, or by a date-coder if you go semi-automated later).

---

## 3. Per-SKU variations

The brand wordmark, layout, and back-panel structure stay **constant across all pickle types**. Only these change per SKU:

| Element | Changes per SKU? | Example |
|---------|------------------|---------|
| Product common name | Yes | "Mango Pickle" / "Lime Pickle" / "Mixed Vegetable Pickle" |
| Front-panel sub-descriptor | Yes | "in Mustard Oil" / "in Sesame Oil" / etc. |
| Ingredients list | Yes | Each pickle's actual ingredients |
| Allergen line | Yes (always declare what's in the recipe) | |
| Nutritional table | Yes (per recipe) | |
| Accent color | Optional | E.g., spice-red for mango, deep-green for lime, mustard-yellow for chili |
| Veg symbol position, FSSAI block, MRP block, manufacturer block, address | **No — keep identical across SKUs.** | |

Standardizing the right-hand-side info block across all pickle SKUs lets the print shop print **shared back-panel plates** and only swap the ingredients/nutrition/SKU name section, which cuts label cost per SKU dramatically once you have 4+ varieties.

---

## 4. Physical spec for the print shop

We will commission a wraparound label sized to the 250g round jar (63mm body diameter).

| Attribute | Spec |
|-----------|------|
| **Label width** | ~190mm (= π × 63mm body, with 5mm overlap glue strip) |
| **Label height** | 70mm (final — confirm against jar body height between shoulder and base) |
| **Material** | Pressure-sensitive **paper label** with **matte laminate finish** OR **uncoated textured paper** (textured uncoated reads more "artisan", but bleeds in humidity — laminate is safer) |
| **Print** | 4-color CMYK + spot varnish on logo (optional, premium touch) |
| **Adhesive** | Permanent, food-grade, oil-resistant (mustard oil seeps — confirm with print shop) |
| **Cut** | Die-cut rectangle, rounded corners (r ≈ 3mm) |
| **Bleed** | 3mm on all sides |
| **Safe area** | Keep type 5mm from edges |
| **Resolution** | 300 DPI |
| **Color profile** | CMYK, ICC profile from print shop (usually Coated FOGRA39) |

**Get quotes for:**
- 500 labels per SKU
- 1,000 labels per SKU
- 5,000 labels per SKU

Local Bangalore options to compare: **Vijay Printers (Wilson Garden), JK Printers (Lalbagh), Pioneer Printers (Indiranagar)**, plus online (PrintLand, Bizay) for baseline pricing.

---

## 5. Brand visual rules (so SKUs look like a family)

| Element | Rule |
|---------|------|
| **Wordmark** | Always "Mother's Gold Spice" in serif italic (matches website). Never abbreviated to "MGS" on the principal panel. |
| **Tagline** | "Hand-made in Bangalore · Small Batch" (or just "Hand-made in Bangalore") |
| **Primary colors** | Cream (#fbf6ec) background, Spice (#7a1f10) for headings, Ink (#2a1a10) for body |
| **Accent per SKU** | Optional — mango uses warm orange (#e08712); other SKUs can use different warm accents but must stay within the warm palette (no cool blues/greens except the legally-required veg symbol) |
| **Fonts on label** | Headings: Fraunces (or Cormorant / Playfair as fallback). Body: Inter. Use only these two. |
| **Photography on label** | No photography — illustrations or none at all. Photography ages poorly and looks generic. |
| **Illustrations** | Simple line-art mango / leaf motifs are OK. Keep monochrome (one color). |
| **Veg symbol** | Always present, always upper right of front panel. |

---

## 6. Pre-print checklist

Before you send a label to print:

- ☐ FSSAI license number is filled in (not `[______________]`)
- ☐ MRP is filled in
- ☐ Manufacturer address is the full address with PIN code
- ☐ Nutritional values are filled in from a **lab-tested** sample (or accredited nutrition calculator)
- ☐ Ingredients percentage in front-of-pack matches actual recipe
- ☐ Veg symbol is present, correct color, correct shape
- ☐ All text proof-read by someone *other than you*
- ☐ Date format is consistent throughout (use DD/MM/YYYY)
- ☐ Phone number format is `+91 XXXXX XXXXX` if added later
- ☐ Print shop sent a **wet proof** (a single physical print) before bulk run — never approve from a screen

---

## 7. After the first SKU ships

- Send a finished labeled jar sample to **2–3 trusted people** *outside* the family. Ask them: "what does this brand stand for, in one sentence?" If the answer differs wildly from "premium homemade mango pickle from Bangalore", the label isn't communicating.
- Re-shoot the website Hero and Product photos with the real labeled jar.
- Update the Amazon listing photos.
