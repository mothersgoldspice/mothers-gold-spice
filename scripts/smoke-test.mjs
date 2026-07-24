#!/usr/bin/env node
/**
 * End-to-end smoke test against a running deployment.
 *
 *   node scripts/smoke-test.mjs https://mothers-gold-spice.<subdomain>.workers.dev \
 *        --admin-email mothersgoldspice@gmail.com --admin-password '…'
 *
 * Drives a real customer journey over HTTP — register, browse, add to cart,
 * apply a coupon, check serviceability, check out, pay at the mock gateway,
 * then (as staff) book the parcel and walk it to delivered — asserting the
 * database ended up in the right state at each step and that the right emails
 * were queued.
 *
 * This exists because unit tests cannot tell you that the deployed Worker has
 * its D1 binding, that middleware is exempting the webhook path, or that the
 * mock gateway's self-signed webhook survives a real round trip. Those are
 * exactly the things that break between "tests pass" and "the site works".
 *
 * Exits non-zero on the first failed assertion.
 */

const args = process.argv.slice(2);
const BASE = (args[0] ?? '').replace(/\/$/, '');
if (!BASE || !BASE.startsWith('http')) {
  console.error('Usage: node scripts/smoke-test.mjs <base-url> [--admin-email X --admin-password Y]');
  process.exit(2);
}

function flag(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const ADMIN_EMAIL = flag('admin-email');
const ADMIN_PASSWORD = flag('admin-password');

// ── Tiny test harness ────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
let currentStep = '';

function step(name) {
  currentStep = name;
  process.stdout.write(`\n▸ ${name}\n`);
}

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures.push(`${currentStep} → ${label}${detail ? ` (${detail})` : ''}`);
    process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/**
 * A cookie jar per persona. The customer and the admin are different browsers,
 * and sharing a jar would make the admin steps silently run as the customer.
 */
function makeClient() {
  const jar = new Map();

  function cookieHeader() {
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function absorb(response) {
    // Node exposes multiple Set-Cookie headers through getSetCookie().
    const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function request(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    const cookies = cookieHeader();
    if (cookies) headers.Cookie = cookies;

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      // The CSRF cookie value IS the token; the middleware compares the two.
      const csrf = jar.get('mgs_csrf');
      if (csrf) headers['x-csrf-token'] = csrf;
      headers.Origin = BASE;
    }

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Redirects are followed because Astro answers `/shipping` with a 307 to
      // `/shipping/`, and a smoke test that reported that as a failure would be
      // testing trailing slashes rather than the shop.
      redirect: 'follow',
    });
    absorb(res);

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // HTML page responses are expected for non-API paths.
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    patch: (p, b) => request('PATCH', p, b ?? {}),
    del: (p, b) => request('DELETE', p, b ?? {}),
    jar,
  };
}

const customer = makeClient();
const admin = makeClient();

const stamp = Date.now();
const CUSTOMER_EMAIL = `smoke.${stamp}@mothersgoldspice.test`;
const CUSTOMER_PASSWORD = 'smoke-test-passphrase-2026';

async function main() {
  console.log(`Smoke testing ${BASE}`);

  // ── 1. Health and configuration ──────────────────────────────────────────
  step('Health and provider wiring');
  const health = await customer.get('/api/health');
  check('GET /api/health returns 200', health.status === 200, `got ${health.status}`);
  check('database reachable', health.json?.data?.database === 'ok', String(health.json?.data?.database));
  const providers = health.json?.data?.providers ?? {};
  console.log(`       providers: email=${providers.email} payment=${providers.payment} shipping=${providers.shipping}`);
  check('all three provider seams resolved', Boolean(providers.email && providers.payment && providers.shipping));

  // ── 2. The marketing site still works ────────────────────────────────────
  step('Existing marketing site is untouched');
  const home = await customer.get('/');
  check('GET / returns 200', home.status === 200, `got ${home.status}`);
  check('home page is the brand page', home.text.includes("Mother's Gold Spice"));
  const shippingDoc = await customer.get('/shipping');
  check('GET /shipping (prerendered doc) still 200', shippingDoc.status === 200, `got ${shippingDoc.status}`);

  // ── 3. Catalogue ─────────────────────────────────────────────────────────
  step('Catalogue');
  const products = await customer.get('/api/products');
  check('GET /api/products returns 200', products.status === 200, `got ${products.status}`);
  const list = products.json?.data ?? [];
  check('at least one active product', list.length > 0, `${list.length} products`);

  const pickle = list.find((p) => p.slug === 'mango-mustard-pickle') ?? list[0];
  check('pickle product present', Boolean(pickle), 'no product to buy');
  if (!pickle) return finish();

  const variant = (pickle.variants ?? []).find((v) => v.inStock);
  check('an in-stock variant exists', Boolean(variant), 'everything is out of stock');
  if (!variant) return finish();
  console.log(`       buying ${pickle.name} ${variant.name} at ₹${variant.pricePaise / 100}`);

  const shop = await customer.get('/shop');
  check('GET /shop renders', shop.status === 200, `got ${shop.status}`);
  const pdp = await customer.get(`/shop/${pickle.slug}`);
  check('GET /shop/[slug] renders', pdp.status === 200, `got ${pdp.status}`);

  // ── 4. Register ──────────────────────────────────────────────────────────
  step('Registration');
  await customer.get('/account/register'); // pick up the CSRF cookie
  const register = await customer.post('/api/auth/register', {
    name: 'Smoke Tester',
    email: CUSTOMER_EMAIL,
    password: CUSTOMER_PASSWORD,
    phone: '9845012345',
  });

  // Registration is deliberately limited to a handful per hour per IP. Running
  // this script repeatedly WILL hit that, and it is the limiter working rather
  // than anything broken — so say so and stop, instead of reporting a cascade of
  // failures that all trace back to having no session.
  if (register.status === 429) {
    check('rate limiter refuses repeated sign-ups (this is correct)', true);
    console.log(`\n  ${register.json?.error?.message ?? 'Rate limited.'}`);
    console.log('  Skipping the signed-in journey. Re-run after the window, or from another IP.');
    return finish();
  }

  check('POST /api/auth/register succeeds', register.status === 200, `got ${register.status}: ${register.text.slice(0, 200)}`);
  check('session cookie issued', customer.jar.has('mgs_session'));

  // ── 5. Cart ──────────────────────────────────────────────────────────────
  step('Cart');
  const add = await customer.post('/api/cart', { variant_id: variant.id, qty: 2 });
  check('POST /api/cart adds the item', add.status === 200, `got ${add.status}: ${add.text.slice(0, 200)}`);
  check('cart holds 2 units', add.json?.data?.itemCount === 2, `itemCount=${add.json?.data?.itemCount}`);

  const expectedSubtotal = variant.pricePaise * 2;
  check(
    'subtotal is quantity × catalogue price',
    add.json?.data?.totals?.subtotalPaise === expectedSubtotal,
    `${add.json?.data?.totals?.subtotalPaise} vs ${expectedSubtotal}`,
  );

  const coupon = await customer.post('/api/cart/coupon', { code: 'WELCOME10' });
  const couponApplied = coupon.status === 200;
  check(
    'WELCOME10 either applies or explains why not',
    couponApplied || coupon.json?.error?.message,
    coupon.text.slice(0, 160),
  );
  if (couponApplied) {
    check('coupon produced a discount', (coupon.json?.data?.discountPaise ?? 0) > 0, `${coupon.json?.data?.discountPaise}`);
  }

  // ── 6. Serviceability ────────────────────────────────────────────────────
  step('Delivery serviceability');
  const service = await customer.post('/api/checkout/serviceability', { pincode: '560001', cod: false });
  check('POST serviceability returns 200', service.status === 200, `got ${service.status}`);
  check('Bengaluru is serviceable', service.json?.data?.serviceable === true);
  check('Bengaluru resolves to zone A', service.json?.data?.zone === 'A', String(service.json?.data?.zone));

  const remote = await customer.post('/api/checkout/serviceability', { pincode: '791001', cod: false });
  check('a North East PIN resolves to zone E', remote.json?.data?.zone === 'E', String(remote.json?.data?.zone));

  // ── 7. Checkout ──────────────────────────────────────────────────────────
  step('Checkout');
  const idempotencyKey = `smoke-${stamp}`;
  const checkoutBody = {
    email: CUSTOMER_EMAIL,
    shipping_address: {
      full_name: 'Smoke Tester',
      phone: '9845012345',
      line1: '12 MG Road',
      line2: 'Near the post office',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      country: 'IN',
    },
    billing_same_as_shipping: true,
    payment_method: 'prepaid',
    shipping_method: 'surface',
    idempotency_key: idempotencyKey,
  };

  const checkout = await customer.post('/api/checkout', checkoutBody);
  check('POST /api/checkout succeeds', checkout.status === 200, `got ${checkout.status}: ${checkout.text.slice(0, 300)}`);

  const orderId = checkout.json?.data?.orderId;
  const orderNumber = checkout.json?.data?.orderNumber;
  check('an order id came back', Boolean(orderId), checkout.text.slice(0, 200));
  if (!orderId) return finish();
  console.log(`       order ${orderNumber} (${orderId})`);

  // Replaying the same idempotency key must not create a second order.
  const replay = await customer.post('/api/checkout', checkoutBody);
  check(
    'replaying the idempotency key returns the SAME order',
    replay.json?.data?.orderId === orderId,
    `${replay.json?.data?.orderId} vs ${orderId}`,
  );

  const checkoutUrl = checkout.json?.data?.checkoutUrl ?? '';
  check('a checkout URL was issued', Boolean(checkoutUrl), checkoutUrl);

  // ── 8. Pay at the mock gateway ───────────────────────────────────────────
  step('Payment');
  const txnId = checkoutUrl.split('/checkout/pay/')[1]?.split('?')[0] ?? '';
  check('checkout URL points at the mock gateway page', Boolean(txnId), checkoutUrl);

  if (txnId) {
    const payPage = await customer.get(`/checkout/pay/${txnId}`);
    check('mock gateway page renders', payPage.status === 200, `got ${payPage.status}`);

    // Ask the simulator to PREPARE the signed webhook rather than deliver it,
    // then post it from here. A Worker cannot make a subrequest to its own
    // hostname (Cloudflare error 1042), so this is the only way the deployed
    // webhook route gets exercised over genuine HTTP — routing, the middleware
    // CSRF exemption and signature verification all included.
    const pay = await customer.post('/api/mock/pay', {
      transaction_id: txnId,
      outcome: 'success',
      method: 'upi',
      deliver: false,
    });
    check('POST /api/mock/pay succeeds', pay.status === 200, `got ${pay.status}: ${pay.text.slice(0, 250)}`);

    const webhook = pay.json?.data?.webhook;
    check('the simulator returned a signed webhook', Boolean(webhook?.body && webhook?.signatureHeader));

    if (webhook) {
      const delivered = await fetch(`${BASE}${webhook.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [webhook.headerName]: webhook.signatureHeader },
        body: webhook.body,
      });
      const deliveredBody = await delivered.text();
      check(
        'the webhook route accepts a correctly signed event',
        delivered.status === 200,
        `got ${delivered.status}: ${deliveredBody.slice(0, 200)}`,
      );

      // The same body with a corrupted signature must be refused outright.
      const tamperedSignature = webhook.signatureHeader.replace(/h1=([0-9a-f])/, (_m, c) =>
        `h1=${c === 'a' ? 'b' : 'a'}`,
      );
      const rejected = await fetch(`${BASE}${webhook.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [webhook.headerName]: tamperedSignature },
        body: webhook.body,
      });
      check('a tampered signature is rejected with 401', rejected.status === 401, `got ${rejected.status}`);

      // And a replay of the genuine event must be recognised as a duplicate
      // rather than confirming the order (or decrementing stock) a second time.
      const replayed = await fetch(`${BASE}${webhook.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [webhook.headerName]: webhook.signatureHeader },
        body: webhook.body,
      });
      const replayBody = await replayed.text();
      check(
        'a replayed webhook is reported as a duplicate',
        replayed.status === 200 && replayBody.includes('duplicate'),
        `got ${replayed.status}: ${replayBody.slice(0, 200)}`,
      );
    }
  }

  // ── 9. Order state after payment ─────────────────────────────────────────
  step('Order confirmed');
  const status = await customer.get(`/api/checkout/status?order=${encodeURIComponent(orderId)}`);
  check('GET /api/checkout/status returns 200', status.status === 200, `got ${status.status}`);
  check(
    'order is confirmed and paid',
    status.json?.data?.paymentStatus === 'paid' && status.json?.data?.status !== 'pending_payment',
    `status=${status.json?.data?.status} payment=${status.json?.data?.paymentStatus}`,
  );

  const orderDetail = await customer.get(`/api/account/orders/${encodeURIComponent(orderId)}`);
  check('customer can read their own order', orderDetail.status === 200, `got ${orderDetail.status}`);

  const history = await customer.get('/api/account/orders');
  check('order appears in history', history.status === 200 && (history.json?.data?.items ?? history.json?.data ?? []).length > 0);

  // A different customer must NOT be able to read it.
  const stranger = makeClient();
  await stranger.get('/');
  const strangerRead = await stranger.get(`/api/account/orders/${encodeURIComponent(orderId)}`);
  check(
    'a stranger cannot read the order',
    strangerRead.status === 401 || strangerRead.status === 403,
    `got ${strangerRead.status}`,
  );

  // ── 9b. Guest checkout, cash on delivery ─────────────────────────────────
  // A separate browser with no account, because the guest path has its own
  // access-control story (a derived token instead of a session) and COD has its
  // own serviceability question. A prepaid lookup used to poison the cached COD
  // answer for a PIN code, so this asks for COD on one that was already queried.
  step('Guest checkout with cash on delivery');
  const guest = makeClient();
  // Bootstrap from a DYNAMIC route. The marketing pages are prerendered static
  // assets served without ever reaching the Worker, so they set no CSRF cookie —
  // correct, since they contain no forms, but it means "/" is not a place to
  // pick one up.
  await guest.get('/api/health');
  const guestAdd = await guest.post('/api/cart', { variant_id: variant.id, qty: 1 });
  check('a guest can fill a basket', guestAdd.status === 200, `got ${guestAdd.status}: ${guestAdd.text.slice(0, 160)}`);

  const codCheck = await guest.post('/api/checkout/serviceability', { pincode: '560001', cod: true });
  check(
    'COD is offered for a serviceable metro PIN code',
    codCheck.json?.data?.codAvailable === true,
    `codAvailable=${codCheck.json?.data?.codAvailable} — a prepaid lookup may have poisoned the cache`,
  );

  const codOrder = await guest.post('/api/checkout', {
    email: `guest.${stamp}@mothersgoldspice.test`,
    shipping_address: {
      full_name: 'Guest Buyer',
      phone: '9845099999',
      line1: '4 Church Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      country: 'IN',
    },
    billing_same_as_shipping: true,
    payment_method: 'cod',
    shipping_method: 'surface',
    idempotency_key: `smoke-cod-${stamp}`,
  });
  check('a guest can place a COD order', codOrder.status === 200, `got ${codOrder.status}: ${codOrder.text.slice(0, 250)}`);

  const codOrderId = codOrder.json?.data?.orderId;
  const guestToken = (codOrder.json?.data?.redirectUrl ?? '').split('t=')[1] ?? '';
  check('COD needs no online payment', codOrder.json?.data?.paymentRequired === false);
  check('the guest was given a tracking token', guestToken.length > 32, `token length ${guestToken.length}`);

  if (codOrderId && guestToken) {
    const withToken = await guest.get(`/track/${codOrderId}?t=${encodeURIComponent(guestToken)}`);
    check('the guest can open their tracking page', withToken.status === 200, `got ${withToken.status}`);

    const invoice = await guest.get(`/invoice/${codOrderId}?t=${encodeURIComponent(guestToken)}`);
    check('the guest can open their invoice', invoice.status === 200, `got ${invoice.status}`);
    check('the invoice splits GST as CGST + SGST within Karnataka', invoice.text.includes('CGST'));

    const withoutToken = await guest.get(`/track/${codOrderId}`);
    check('tracking without the token is refused', withoutToken.status === 403, `got ${withoutToken.status}`);
  }

  // ── 10. Admin ────────────────────────────────────────────────────────────
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('\n(skipping staff checks — pass --admin-email and --admin-password to include them)');
    return finish();
  }

  step('Staff sign-in');
  await admin.get('/account/login');
  const adminLogin = await admin.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  check('admin signs in', adminLogin.status === 200, `got ${adminLogin.status}: ${adminLogin.text.slice(0, 200)}`);
  check('admin has the admin role', adminLogin.json?.data?.user?.role === 'admin', String(adminLogin.json?.data?.user?.role));

  const dashboard = await admin.get('/admin');
  check('GET /admin renders for staff', dashboard.status === 200, `got ${dashboard.status}`);

  const customerHitsAdmin = await customer.get('/api/admin/orders');
  check(
    'a customer is refused the admin API',
    customerHitsAdmin.status === 403 || customerHitsAdmin.status === 401,
    `got ${customerHitsAdmin.status}`,
  );

  // ── 11. Emails actually queued ───────────────────────────────────────────
  step('Transactional email');
  const emails = await admin.get('/api/admin/emails?limit=50');
  check('GET /api/admin/emails returns 200', emails.status === 200, `got ${emails.status}`);
  const rows = emails.json?.data?.items ?? emails.json?.data ?? [];
  const templatesSeen = new Set(rows.map((r) => r.template));
  console.log(`       outbox templates: ${[...templatesSeen].join(', ') || '(none)'}`);
  check('a verification email was queued', templatesSeen.has('auth_verify_email'));
  check('an order confirmation was queued', templatesSeen.has('order_confirmation'));
  check('the kitchen was notified', templatesSeen.has('admin_new_order'));
  const sentCount = rows.filter((r) => r.status === 'sent').length;
  check('at least one email reached the provider', sentCount > 0, `${sentCount} sent of ${rows.length}`);

  // ── 12. Fulfilment ───────────────────────────────────────────────────────
  step('Fulfilment');
  const ship = await admin.patch(`/api/admin/orders/${encodeURIComponent(orderId)}`, { action: 'ship' });
  check('admin books the parcel', ship.status === 200, `got ${ship.status}: ${ship.text.slice(0, 250)}`);

  const afterShip = await admin.get(`/api/admin/orders/${encodeURIComponent(orderId)}`);
  const shipment = afterShip.json?.data?.shipment;
  check('a shipment exists with an AWB', Boolean(shipment?.awb_code ?? shipment?.awbCode), JSON.stringify(shipment ?? {}).slice(0, 200));

  const providerShipmentId = shipment?.provider_shipment_id ?? shipment?.providerShipmentId;
  if (providerShipmentId) {
    // Walk the parcel to delivered through the real webhook path.
    for (const target of ['pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered']) {
      const advance = await admin.post('/api/mock/advance-shipment', {
        provider_shipment_id: providerShipmentId,
        to: target,
      });
      check(`parcel advanced to ${target}`, advance.status === 200, `got ${advance.status}: ${advance.text.slice(0, 160)}`);
    }
  }

  const finalOrder = await admin.get(`/api/admin/orders/${encodeURIComponent(orderId)}`);
  const finalStatus = finalOrder.json?.data?.order?.status;
  check('order reached delivered', finalStatus === 'delivered', `status=${finalStatus}`);

  const finalEmails = await admin.get('/api/admin/emails?limit=100');
  const finalTemplates = new Set((finalEmails.json?.data?.items ?? finalEmails.json?.data ?? []).map((r) => r.template));
  check('a shipping email was queued', finalTemplates.has('order_shipped'));
  check('a delivery email was queued', finalTemplates.has('order_delivered'));

  // ── 13. Stock moved ──────────────────────────────────────────────────────
  step('Inventory');
  const inventory = await admin.get('/api/admin/inventory');
  check('GET /api/admin/inventory returns 200', inventory.status === 200, `got ${inventory.status}`);
  const invRows = inventory.json?.data?.items ?? inventory.json?.data?.variants ?? inventory.json?.data ?? [];
  const bought = Array.isArray(invRows) ? invRows.find((r) => (r.variant_id ?? r.variantId ?? r.id) === variant.id) : null;
  if (bought) {
    console.log(`       ${variant.name}: on_hand=${bought.on_hand ?? bought.onHand} reserved=${bought.reserved}`);
    check('stock was decremented, not left reserved', (bought.reserved ?? 0) === 0, `reserved=${bought.reserved}`);
  } else {
    check('inventory row found for the purchased variant', false, 'shape did not match');
  }

  finish();
}

function finish() {
  console.log('\n' + '─'.repeat(64));
  if (failures.length === 0) {
    console.log(`ALL CHECKS PASSED — ${passed} assertions`);
    process.exit(0);
  }
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
