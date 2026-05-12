# Pricing & Unit Economics

> **How to use this doc:**
> 1. Fill in the `__FILL__` placeholders as you measure / source real numbers.
> 2. The formulas at the bottom will tell you whether the price is viable.
> 3. Don't ship until per-jar margin (after Amazon fees) is at least 30–40% — otherwise the business loses money on every sale.

Currency: ₹ (INR). Reference jar size: **250g** (adjust if you launch with 500g).

---

## 1. Cost stack (per 250g jar)

### A. Direct ingredient cost
Measured **per batch**, then divided by jars produced.

| Item | Batch quantity | Batch cost | Cost per jar (= batch cost ÷ jars made) |
|------|----------------|-----------|------------------------------------------|
| Raw mango (kg) | __FILL__ kg | ₹__FILL__ | ₹__FILL__ |
| Mustard oil (L) | __FILL__ L | ₹__FILL__ | ₹__FILL__ |
| Mustard seeds | __FILL__ g | ₹__FILL__ | ₹__FILL__ |
| Fenugreek (methi) | __FILL__ g | ₹__FILL__ | ₹__FILL__ |
| Red chili powder | __FILL__ g | ₹__FILL__ | ₹__FILL__ |
| Salt | __FILL__ g | ₹__FILL__ | ₹__FILL__ |
| Turmeric (haldi) | __FILL__ g | ₹__FILL__ | ₹__FILL__ |
| Asafoetida (hing) | __FILL__ g | ₹__FILL__ | ₹__FILL__ |
| Other spices | __FILL__ | ₹__FILL__ | ₹__FILL__ |
| **Subtotal — Ingredients** | | | **₹__FILL__** |

> **How many jars per batch?** Roughly: (mango kg + spice mass + oil weight) × ~0.85 (water loss in sun-drying) ÷ 0.25 kg per jar. Measure this on your first real batch — it's the single most important number in this doc.

### B. Packaging (per jar)

| Item | Cost | Notes |
|------|------|-------|
| Glass jar with lid | ₹__FILL__ | Bulk wholesale (≥100 units) typically ₹20–40 per jar |
| Label (printed sticker) | ₹__FILL__ | ₹3–8 from a local print shop; cheaper at higher quantity |
| Tamper seal / cap shrink | ₹__FILL__ | ₹1–3 per jar |
| Outer carton + bubble wrap (Amazon ship) | ₹__FILL__ | ₹15–30 per unit including filler |
| **Subtotal — Packaging** | **₹__FILL__** | |

### C. Allocated overhead (per jar)
Take annual cost ÷ jars sold per year.

| Item | Annual cost | Allocated per jar (assume __FILL__ jars/year) |
|------|-------------|-----------------------------------------------|
| FSSAI license | ₹2,000 / yr (basic) | ₹__FILL__ |
| Domain + hosting | ₹1,000 / yr (currently mostly free) | ₹__FILL__ |
| Photography / brand assets (amortize over a year) | ₹__FILL__ | ₹__FILL__ |
| Kitchen utilities allocation | ₹__FILL__ | ₹__FILL__ |
| **Subtotal — Overhead** | | **₹__FILL__** |

### D. Labor (per jar)
**Even if it's family, value the hours.** Otherwise the business looks profitable but is actually subsidizing itself with unpaid time.

| | Value |
|---|-------|
| Hours per batch (harvesting + prep + cooking + jarring) | __FILL__ hr |
| Hourly value (use a fair wage — at minimum, what a Bangalore home-cook helper costs: ~₹150/hr) | ₹__FILL__ /hr |
| **Labor cost per batch** | ₹__FILL__ |
| **Labor cost per jar** (÷ jars per batch) | **₹__FILL__** |

### E. Total landed cost per jar (before any channel fee)
```
Total cost / jar = Ingredients (A) + Packaging (B) + Overhead (C) + Labor (D)
```
**= ₹__FILL__**

This is your floor. Below this, you're losing money on every jar.

---

## 2. Channel-specific costs

### Amazon India (Professional Seller)

Amazon's grocery category fees (verify on Amazon Seller Central — they update these):

| Fee | Typical for 250g pickle jar |
|-----|----------------------------|
| **Referral fee** (% of selling price) | 15% if SP < ₹500, otherwise 10% |
| **Closing fee** (flat per order) | ~₹10–25 |
| **Shipping** | If you self-ship via Amazon Easy Ship: ₹50–90 for first 500g. If FBA: ₹35–60 per unit (cheaper but ties up inventory at Amazon's warehouse) |
| **Subscription fee** | ₹3,996 / month (Pro plan, flat — fixed cost, not per jar) |
| **GST on fees** | 18% on the above fees |

**Amazon take-home formula:**
```
amazon_takehome = selling_price
                - referral_fee
                - closing_fee
                - ship_fee
                - GST_on_fees (18% × sum of above)
                - GST_paid_to_govt_on_sale (12% of selling price for fruit pickle — confirm with CA)
```

**Worked example for ₹399 selling price on Amazon, self-ship:**
- Referral fee: 15% × 399 = ₹59.85
- Closing fee: ~₹15
- Shipping: ~₹70
- GST on fees: 18% × 144.85 = ₹26.07
- GST paid on sale: 12% × 399 = ₹47.88 (this you collect from customer and remit; treat as pass-through, but customer's effective price is ₹399 inclusive — you net before remitting)
- **Net Amazon take-home (excl. GST pass-through): ₹399 − 59.85 − 15 − 70 − 26.07 ≈ ₹228**
- If cost/jar is ₹100, gross margin ≈ ₹128/jar (56%).

### D2C from mothersgoldspice.com

| Fee | Typical |
|-----|---------|
| Payment gateway (Razorpay / Cashfree) | 2% + 18% GST on the fee = effective 2.36% |
| Shipping (DTDC / Shadowfax / Bluedart courier) | ₹50–120 within India for 500g–1kg |
| Cloudflare hosting | Free at this scale |

**D2C is significantly more profitable per unit**, but volume is lower until you have an audience. Most early-stage D2C food brands run 80/20 Amazon/D2C in the first year, then shift toward D2C as the audience grows.

---

## 3. Pricing strategy

### Pick positioning *first*, then check if cost allows the margin.

| Tier | Selling price (250g) | Who it's for | Examples |
|------|---------------------|--------------|----------|
| Mass market | ₹120–250 | Daily grocery, price-sensitive | Nilon's, Mother's Recipe, Priya, Dabur Hommade |
| Mid-premium | ₹250–400 | Quality-conscious urban families | Sundrop Pickles, Sprig, Patanjali Premium |
| **Premium artisan / D2C** | **₹400–700+** | Gift, story-driven, ingredient-quality buyers | Two Brothers Organic Farms, Pure & Sure, homemade.in, Phalada, The Whole Truth |

Given the brand we built (hand-made, small-batch, Bangalore, no preservatives), the natural positioning is **premium artisan** — ₹400–550 range for 250g. The website's story, photos, and tone already do the heavy lifting for that positioning; mass-market pricing would actively *hurt* the brand by signaling commodity.

### Sanity-check competitor pricing on Amazon
Before locking in your price, do this:
1. Search Amazon India for: `mango pickle 250g`, `homemade mango pickle`, `mango pickle small batch`
2. Filter to the top 20 results
3. Note: SP, customer rating, number of reviews
4. Pay attention to listings with similar story (mother-made / hand-made / no preservatives) — these are your direct competitors

**Aim for the upper-middle of that band** — not the cheapest (which kills margin and brand), not the most expensive (which kills early discovery). For a 250g jar, that's likely ₹399–499.

---

## 4. Final viability check

After filling in sections 1 and 2, compute these:

```
COST_PER_JAR        = ₹__FILL__   (from §1.E)
AMAZON_TAKEHOME     = ₹__FILL__   (using §2 formula at chosen SP)
GROSS_MARGIN_AMZN   = AMAZON_TAKEHOME − COST_PER_JAR
GM%_AMZN            = GROSS_MARGIN_AMZN ÷ AMAZON_TAKEHOME × 100

DTC_TAKEHOME        = SELLING_PRICE × (1 − 0.0236) − shipping_paid_by_us (if any)
GROSS_MARGIN_DTC    = DTC_TAKEHOME − COST_PER_JAR
GM%_DTC             = GROSS_MARGIN_DTC ÷ DTC_TAKEHOME × 100
```

**Targets:**
- Gross margin on Amazon: ≥ 35%
- Gross margin on D2C: ≥ 60%
- Overall break-even: Amazon margin × monthly Amazon volume + D2C margin × monthly D2C volume ≥ fixed monthly costs (Pro plan ₹3,996 + license amortization + other overhead)

**If targets aren't met:**
1. **Lower COGS** — bulk-buy mangoes when in season, pickle and store for off-season sale; bulk packaging order (≥1000 jars typically halves per-unit jar cost).
2. **Raise price** — premium positioning supports it. ₹449 → ₹499 might lose 5% of buyers but adds ~10% margin.
3. **Switch jar size** — selling 500g at ₹699 has better margin than 250g at ₹399 because packaging cost doesn't double when contents do.

---

## 5. Action items (in order)

1. ⬜ Make your next batch with a **weighing scale** and **kitchen timer** running. Record every ingredient weight and the total time worked. Count the final jars produced.
2. ⬜ Get quotes for jars in 100/500/1000 unit lots from at least 3 suppliers (try IndiaMART, Alibaba India, local Bangalore packaging wholesalers).
3. ⬜ Get a label quote from a local print shop (sticker label, 4-color, glossy or matte).
4. ⬜ Plug all numbers into §1 and §4. Iterate.
5. ⬜ Once §4 looks healthy, set the launch price and update the Product section caption + Amazon listing.

---

## 6. Next step (when numbers stabilize)

Once you have 2–3 real batches measured, we'll build an **interactive pricing calculator** at `mothersgoldspice.com/admin/pricing` (private, behind login). It'll let you slide ingredient costs / volumes / selling price and watch margin update live — useful when you're negotiating with suppliers or deciding whether to raise prices.

Until then, this doc is the source of truth — keep it updated as you learn.
