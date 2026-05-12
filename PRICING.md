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

### Quick commerce (Blinkit / Zepto / Swiggy Instamart)

These platforms **buy from you wholesale**, then sell to customers themselves. You don't set the customer's price directly — you negotiate a **wholesale rate**, they decide MRP. They handle delivery, returns, and customer support.

| Item | Typical |
|------|---------|
| Wholesale rate they pay you | **60–75% of MRP** (i.e., they keep 25–40% margin) |
| Catalog onboarding / listing | Sometimes a one-time fee (varies; often waived for promising brands) |
| Marketing / in-app promotion | 2–5% of sales **if** you opt in (heavily recommended early on for visibility) |
| Wastage / returns reserve | They deduct 3–5% upfront against unsold/damaged stock |
| Payment cycle | **30–45 days** after invoicing |
| GST | Mandatory. You issue a B2B GST invoice to them; they claim Input Tax Credit |
| Logistics | You ship in bulk to their dark store / warehouse (10–50 units per drop) |

**Quick-commerce take-home formula:**
```
qc_takehome_per_jar = MRP × wholesale_rate
                    - (MRP × marketing_pct, if opted in)
                    - (MRP × wastage_reserve_pct)
                    - bulk_shipping_cost_per_jar
```

**Worked example for ₹449 MRP, 65% wholesale rate, 3% marketing, 4% wastage reserve:**
- Wholesale revenue: 449 × 0.65 = ₹291.85
- Marketing deduction: 449 × 0.03 = ₹13.47
- Wastage reserve: 449 × 0.04 = ₹17.96
- Bulk shipping to dark store (50-unit drops): ~₹4 per jar
- **Net per jar: 291.85 − 13.47 − 17.96 − 4 ≈ ₹256**
- If cost/jar is ₹100, gross margin ≈ ₹156/jar (~61%).

**Reality check:** these platforms are **category-managed** (their buyers decide which brands get listed). New, unknown brands frequently get rejected on the first application. Improve odds by applying with: existing Amazon reviews, Instagram following ≥1K, and proof of being stocked in ≥2 retail locations. Realistically a **month 4–6 channel**, not a launch channel.

### Physical retail (specialty stores in Bangalore)

Two models, choose per-store based on what they offer. Most premium gourmet stores prefer **consignment** for new brands; once you've sold through a few cycles, you can negotiate **outright**.

#### Model A: Outright purchase (preferred)
Store buys stock from you, owns it, sells it.

| Item | Typical |
|------|---------|
| Wholesale rate they pay you | **55–70% of MRP** (they keep 30–45% margin) |
| Payment cycle | Upfront, 7 days, or 15–30 days (negotiate) |
| Returns | Usually not accepted (they own the stock) |
| Logistics | You deliver to each store. Costs ₹10–30 per visit, amortize across jars |

#### Model B: Consignment
You leave stock at the store; payment only after a jar sells. Store has zero capital at risk, so they demand a bigger cut.

| Item | Typical |
|------|---------|
| Effective rate after sale | **50–65% of MRP** (store keeps 35–50%) |
| Payment cycle | After sale, settled monthly |
| Returns | You bear all unsold/expired stock |
| Wastage risk | 2–10% of stock at each store (expiry, damage) |
| Logistics | You deliver, restock, and pull near-expiry stock yourself |

**Retail take-home formula:**
```
retail_takehome_per_jar = MRP × wholesale_rate
                        - delivery_cost_per_jar
                        - (consignment only: MRP × wastage_pct)
```

**Worked example for ₹449 MRP, outright at 60% wholesale, delivery cost ₹15/jar:**
- Wholesale revenue: 449 × 0.60 = ₹269.40
- Delivery cost: ₹15
- **Net per jar: ~₹254**
- If cost/jar is ₹100, gross margin ≈ ₹154/jar (~61%).

**Best fit for premium-artisan positioning in Bangalore** (in rough order of receptiveness to new home-brands):
- The Organic World (Indiranagar, Koramangala) — premium organic, story-friendly
- Independent neighborhood gourmet shops in Indiranagar, Koramangala, HSR, Whitefield, Jayanagar
- Namdhari's Fresh
- Modern Bazaar
- Nature's Basket (harder; corporate-owned, longer onboarding)
- Foodhall at UB City (hardest; very curated, but huge brand boost if you get in)

**How to actually approach a store:**
1. Walk in with: 2–3 sample jars + a one-page pitch sheet (brand story, USPs, MRP, wholesale rate, GST/FSSAI numbers, your contact)
2. Ask for the store manager or category buyer (not the cashier)
3. Leave samples, follow up in 3–5 days
4. If interested, they'll ask for a Purchase Order template and your bank details

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

After filling in sections 1 and 2, compute take-home per jar in **every** channel — the lowest one determines your floor MRP.

```
COST_PER_JAR             = ₹__FILL__   (from §1.E)

AMAZON_TAKEHOME          = ₹__FILL__   (§2 Amazon formula)
D2C_TAKEHOME             = MRP × (1 − 0.0236) − shipping_paid_by_us
QUICK_COMMERCE_TAKEHOME  = MRP × wholesale_rate − marketing_deduction − wastage_reserve − bulk_ship
RETAIL_OUTRIGHT_TAKEHOME = MRP × wholesale_rate − delivery_cost
RETAIL_CONSIGN_TAKEHOME  = MRP × wholesale_rate − delivery − wastage

GM%_<channel>            = (TAKEHOME − COST_PER_JAR) ÷ TAKEHOME × 100
```

**Targets per channel:**

| Channel | Min gross margin | Why |
|---------|------------------|-----|
| D2C (own site) | ≥ 60% | You did all the work to acquire the customer — keep most of it |
| Amazon | ≥ 35% | Big audience, high marketing leverage, worth slim margin |
| Quick commerce | ≥ 40% | Same logic as Amazon, but tighter payment cycle hurts cash |
| Physical retail — outright | ≥ 40% | Stable, predictable, low operational burden |
| Physical retail — consignment | ≥ 45% | Higher margin to compensate for inventory risk |

**Overall break-even (monthly):**
```
sum(margin_per_jar × jars_sold_in_channel) ≥ fixed_monthly_costs
```
where fixed costs = Amazon Pro plan (₹3,996) + license amortization + your time (if you're paying yourself) + any subscriptions.

### The big lesson: MRP must work for every channel you want to be in

A common trap: setting MRP to optimize for D2C, then discovering it can't survive the 30–40% cut that Blinkit and retail demand.

**Reverse-engineer the MRP from the *worst* channel:**
```
MRP = COST_PER_JAR ÷ (1 − worst_channel_margin_demanded) ÷ (1 − target_GM)
```

Example: if cost is ₹100, worst channel takes 40% (consignment), and you want 45% GM:
- Net you must receive: 100 ÷ (1 − 0.45) = ₹182
- MRP: 182 ÷ (1 − 0.40) = **₹303 minimum**
- Round up for psychological pricing: **₹329 or ₹349**

If that MRP feels too low for your premium positioning, raise it — premium artisan ₹400–500 still gives healthy margin across all channels at ₹100 cost.

### Channel mix in the first year (rough plan)

| Month | Active channels | Expected revenue split |
|-------|----------------|------------------------|
| 0–2 | D2C + Amazon | 30% D2C / 70% Amazon |
| 2–4 | + 3–5 Bangalore retail stores | 25% D2C / 55% Amazon / 20% retail |
| 4–6 | + Blinkit/Zepto/Instamart | 20% D2C / 40% Amazon / 25% retail / 15% QC |
| 6–12 | Same channels, scaling | 25% D2C / 30% Amazon / 25% retail / 20% QC |

Don't try to launch all four channels at once — each has its own setup, returns process, accounting flow, and operational overhead. Get one channel working profitably before opening the next.

**If targets aren't met:**
1. **Lower COGS** — bulk-buy mangoes when in season, pickle and store for off-season sale; bulk packaging order (≥1000 jars typically halves per-unit jar cost).
2. **Raise price** — premium positioning supports it. ₹449 → ₹499 might lose 5% of buyers but adds ~10% margin.
3. **Switch jar size** — selling 500g at ₹699 has better margin than 250g at ₹399 because packaging cost doesn't double when contents do.

---

## 5. Action items (in order)

### Phase 1 — Foundation (do before any channel goes live)
1. ⬜ Make your next batch with a **weighing scale** and **kitchen timer** running. Record every ingredient weight and the total time worked. Count the final jars produced.
2. ⬜ Get quotes for jars in 100/500/1000 unit lots from at least 3 suppliers (try IndiaMART, Alibaba India, local Bangalore packaging wholesalers).
3. ⬜ Get a label quote from a local print shop (sticker label, 4-color, glossy or matte).
4. ⬜ Plug all numbers into §1 and §4. Iterate until every channel hits its margin target.
5. ⬜ Apply for **GST registration** (mandatory for selling on Blinkit/Amazon, helpful for retail B2B invoicing). Roughly 7–10 working days via the GST portal.

### Phase 2 — Launch (month 0–2)
6. ⬜ Set the MRP (use §4 reverse-engineering). Update the Product section on the website and on Amazon.
7. ⬜ List on Amazon India (Pro Seller plan).
8. ⬜ Enable D2C checkout on mothersgoldspice.com (Razorpay or Cashfree + a courier integration).

### Phase 3 — Local retail (month 2–4)
9. ⬜ Create a one-page **trade sheet** (PDF): brand story, USPs, GST/FSSAI numbers, MRP, wholesale rate (both outright and consignment), your contact.
10. ⬜ Visit 8–12 specialty stores with samples. Aim for 3–5 yes's.
11. ⬜ Set up a simple delivery/restock route (once a week or every other week initially).

### Phase 4 — Quick commerce (month 4–6)
12. ⬜ With Amazon reviews + retail presence as your proof, apply to Blinkit / Zepto / Swiggy Instamart seller portals.
13. ⬜ Negotiate wholesale rate ≥ 60% of MRP, marketing opt-in capped at 3%.

---

## 6. Next step (when numbers stabilize)

Once you have 2–3 real batches measured, we'll build an **interactive pricing calculator** at `mothersgoldspice.com/admin/pricing` (private, behind login). It'll let you slide ingredient costs / volumes / selling price and watch margin update live — useful when you're negotiating with suppliers or deciding whether to raise prices.

Until then, this doc is the source of truth — keep it updated as you learn.
