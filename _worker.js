// YESHUA backend — comenzi, plată Stripe și livrare Easybox (Sameday).
// Static files are served via env.ASSETS (Cloudflare Pages built-in).
//
// Variabile / secrete necesare (Cloudflare Pages → Settings → Environment variables):
//   ADMIN_USERNAME, ADMIN_PASSWORD          – acces /admin
//   STRIPE_SECRET_KEY                        – sk_live_... / sk_test_...
//   STRIPE_WEBHOOK_SECRET                    – whsec_... (din Stripe → Webhooks)
//   SAMEDAY_USERNAME, SAMEDAY_PASSWORD       – credențiale API Sameday (NU loginul din portal)
//   SAMEDAY_PICKUP_POINT_ID                  – id punct de ridicare (din contul Sameday)
//   SAMEDAY_SERVICE_ID                       – id serviciu Easybox / LockerNextDay
//   SAMEDAY_CONTACT_PERSON_ID  (opțional)    – id persoană de contact la punctul de ridicare
//   SAMEDAY_API_URL            (opțional)    – default https://api.sameday.ro
//                                              sandbox: https://sameday-api.demo.zitec.com
//   SITE_ORIGIN                (opțional)    – ex. https://yeshuabook.com (altfel se ia din request)
// Binding D1: env.DB

// ── Preț autoritativ (server) — NU se au în considerare prețurile trimise de client.
const PRODUCTS = {
  fizica:   { label: 'Carte fizică',   price: 55, physical: true  }
  // Varianta digitală e dezactivată deocamdată.
};
// Transport pe zone (RON). Se poate ajusta oricând.
const SHIPPING = { RO: 24.99, EU: 59, WORLD: 119 };
const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','SK','SI','ES','SE'];
const WORLD_COUNTRIES = ['GB','US','CA','CH','NO','AU']; // UK, SUA, Canada, Elveția, Norvegia, Australia
function shippingForCountry(cc) {
  if (cc === 'RO') return SHIPPING.RO;
  if (EU_COUNTRIES.includes(cc)) return SHIPPING.EU;
  if (WORLD_COUNTRIES.includes(cc)) return SHIPPING.WORLD;
  return null; // țară neacceptată
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ── API public ───────────────────────────────────────────
      if (pathname === '/api/orders' && request.method === 'POST') {
        return handleCreateOrder(request, env);
      }
      const pubOrderMatch = pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);
      if (pubOrderMatch && request.method === 'GET') {
        return handlePublicOrder(env, pubOrderMatch[1]);
      }
      if (pathname === '/api/lockers' && request.method === 'GET') {
        return handleLockers(env);
      }
      if (pathname === '/api/stripe/webhook' && request.method === 'POST') {
        return handleStripeWebhook(request, env);
      }

      // ── API admin ────────────────────────────────────────────
      if (pathname === '/api/admin/orders' && request.method === 'GET') {
        return handleListOrders(request, env);
      }
      if (pathname === '/api/admin/sameday/diagnostics' && request.method === 'GET') {
        return handleSamedayDiagnostics(request, env);
      }
      const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]+)$/);
      if (adminOrderMatch && request.method === 'PATCH') {
        return handleUpdateOrder(request, env, adminOrderMatch[1]);
      }
      if (adminOrderMatch && request.method === 'DELETE') {
        return handleDeleteOrder(request, env, adminOrderMatch[1]);
      }
      const awbMatch = pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]+)\/awb$/);
      if (awbMatch && request.method === 'POST') {
        return handleGenerateAwb(request, env, awbMatch[1]);
      }
    } catch (err) {
      return json({ success: false, error: 'Eroare server: ' + (err && err.message || err) }, 500);
    }

    // ── Static assets ──────────────────────────────────────────
    return env.ASSETS.fetch(request);
  }
};

// ────────────────────────────────────────────────────────────────
// Helpers generice
// ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function requireAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  const [user, pass] = token.split(':');
  const okUser = env.ADMIN_USERNAME && user === env.ADMIN_USERNAME;
  const okPass = env.ADMIN_PASSWORD && pass === env.ADMIN_PASSWORD;
  if (!okUser || !okPass) return json({ success: false, error: 'unauthorized' }, 401);
  return null;
}

function generateOrderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (n) => Array.from({ length: n }, () =>
    chars[Math.floor(Math.random() * chars.length)]).join('');
  return `YSH-${part(4)}-${part(4)}`;
}

function validString(v, max = 500) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function siteOrigin(request, env) {
  if (env.SITE_ORIGIN) return env.SITE_ORIGIN.replace(/\/$/, '');
  return new URL(request.url).origin;
}

// Encodare form (application/x-www-form-urlencoded) cu notație PHP-style pentru
// obiecte/array-uri imbricate. Folosită atât de Stripe cât și de Sameday.
//   { a:{ b:1 }, c:[{d:2}] } → a[b]=1&c[0][d]=2
function encodeForm(data) {
  const pairs = [];
  const add = (key, val) => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => add(`${key}[${i}]`, v));
    } else if (typeof val === 'object') {
      for (const k of Object.keys(val)) add(`${key}[${k}]`, val[k]);
    } else {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(val));
    }
  };
  for (const k of Object.keys(data)) add(k, data[k]);
  return pairs.join('&');
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── KV peste D1 (token + cache lockere) ──────────────────────────
async function kvGet(env, key) {
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT value, expires_at FROM app_kv WHERE key = ?').bind(key).first();
  if (!row) return null;
  if (row.expires_at && Date.now() > row.expires_at) return null;
  return row.value;
}
async function kvSet(env, key, value, ttlMs) {
  if (!env.DB) return;
  const expires = ttlMs ? Date.now() + ttlMs : null;
  await env.DB.prepare(
    'INSERT INTO app_kv (key, value, expires_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
  ).bind(key, value, expires).run();
}

// ────────────────────────────────────────────────────────────────
// Comenzi
// ────────────────────────────────────────────────────────────────

async function handleCreateOrder(request, env) {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: 'Invalid JSON' }, 400); }

  // ── Validare ─────────────────────────────────────────────────
  const errors = [];
  const product = body.product;
  if (!PRODUCTS[product]) errors.push('Produs invalid');
  const c = body.customer || {};
  if (!validString(c.name, 200)) errors.push('Nume invalid');
  if (!validString(c.email, 200) || !c.email.includes('@')) errors.push('Email invalid');
  if (!validString(c.phone, 50)) errors.push('Telefon invalid');

  const isPhysical = PRODUCTS[product] && PRODUCTS[product].physical;
  // Plata exclusiv cu cardul (Stripe). Ramburs eliminat.
  const paymentMethod = 'card';

  // Adresă de livrare (România, UE sau internațional — SUA/UK/Canada).
  const sh = body.shipping || {};
  const country = isPhysical ? String(sh.country || 'RO').toUpperCase().slice(0, 2) : null;
  let shippingPrice = 0;
  if (isPhysical) {
    shippingPrice = shippingForCountry(country);
    if (shippingPrice == null) { errors.push('Țară de livrare neacceptată'); shippingPrice = 0; }
    if (!validString(sh.address, 300)) errors.push('Adresă invalidă');
    if (!validString(sh.city, 120)) errors.push('Localitate invalidă');
    if (!validString(sh.postal, 30)) errors.push('Cod poștal invalid');
    // Județ / stat / regiune — opțional (diferă de la o țară la alta).
  }
  if (errors.length) return json({ success: false, error: errors.join('; ') }, 400);

  // ── Prețuri (autoritativ, din server) ────────────────────────
  const unitPrice = PRODUCTS[product].price;
  const total = Math.round((unitPrice + shippingPrice) * 100) / 100;

  const id = generateOrderId();
  const now = new Date().toISOString();
  const productLabel = PRODUCTS[product].label;
  const shippingMethod = isPhysical ? 'Curier — livrare la adresă' : 'Livrare prin email';
  const paymentLabel = 'Card online (Stripe)';
  const paymentStatus = 'pending';

  await env.DB.prepare(`
    INSERT INTO orders (
      id, created_at, status,
      product, product_label, quantity, unit_price, shipping_price, total, currency,
      shipping_method, payment_method, payment_status,
      customer_name, customer_email, customer_phone,
      shipping_country, shipping_address, shipping_city, shipping_postal, shipping_region,
      notes
    ) VALUES (?, ?, 'new', ?, ?, 1, ?, ?, ?, 'RON', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, now,
    product, productLabel, unitPrice, shippingPrice, total,
    shippingMethod, paymentLabel, paymentStatus,
    c.name.trim(), c.email.trim().toLowerCase(), c.phone.trim(),
    isPhysical ? country : null,
    isPhysical ? sh.address.trim() : null,
    isPhysical ? sh.city.trim() : null,
    isPhysical ? sh.postal.trim() : null,
    isPhysical && sh.county ? String(sh.county).trim() : null,
    validString(body.notes || '', 1000) ? body.notes.trim() : null
  ).run();

  const origin = siteOrigin(request, env);

  // ── Plata cu cardul → Stripe Checkout ────────────────────────
  try {
    const session = await createStripeCheckout(env, {
      origin, id, productLabel, unitPrice, shippingPrice, isPhysical,
      email: c.email.trim().toLowerCase()
    });
    await env.DB.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?')
      .bind(session.id, id).run();
    return json({ success: true, orderId: id, redirectUrl: session.url });
  } catch (err) {
    await env.DB.prepare("UPDATE orders SET payment_status = 'failed', awb_error = ? WHERE id = ?")
      .bind('Stripe: ' + (err.message || err), id).run();
    return json({ success: false, error: 'Nu am putut iniția plata. ' + (err.message || '') }, 502);
  }
}

async function handlePublicOrder(env, id) {
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);
  const o = await env.DB.prepare(`
    SELECT id, status, payment_status AS paymentStatus, product_label AS productLabel,
           total, currency, shipping_method AS shippingMethod, awb_number AS awbNumber
    FROM orders WHERE id = ?
  `).bind(id).first();
  if (!o) return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  return json({ success: true, order: o });
}

async function handleLockers(env) {
  try {
    const lockers = await getLockers(env);
    return json({ success: true, lockers });
  } catch (err) {
    return json({ success: false, error: err.message || String(err), lockers: [] }, 502);
  }
}

// ────────────────────────────────────────────────────────────────
// Stripe
// ────────────────────────────────────────────────────────────────

async function createStripeCheckout(env, { origin, id, productLabel, unitPrice, shippingPrice, isPhysical, email }) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY lipsește');

  const lineItems = [{
    quantity: 1,
    price_data: {
      currency: 'ron',
      unit_amount: Math.round(unitPrice * 100),
      product_data: { name: 'YESHUA — ' + productLabel }
    }
  }];
  if (isPhysical && shippingPrice > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'ron',
        unit_amount: Math.round(shippingPrice * 100),
        product_data: { name: 'Transport (livrare prin curier)' }
      }
    });
  }

  const payload = {
    mode: 'payment',
    success_url: `${origin}/thank-you?id=${encodeURIComponent(id)}`,
    cancel_url: `${origin}/checkout?canceled=1`,
    client_reference_id: id,
    customer_email: email,
    metadata: { orderId: id },
    payment_intent_data: { metadata: { orderId: id } },
    line_items: lineItems
  };

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: encodeForm(payload)
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error && data.error.message || 'Eroare Stripe');
  return data;
}

async function handleStripeWebhook(request, env) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'webhook secret not configured' }, 500);

  const payload = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';

  // Header: "t=timestamp,v1=signature[,v1=...]"
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const t = parts.t;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  const provided = sigHeader.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !provided.includes(expected)) {
    return json({ error: 'invalid signature' }, 400);
  }

  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'invalid payload' }, 400); }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const orderId = (session.metadata && session.metadata.orderId) || session.client_reference_id;
    if (orderId && env.DB) {
      await env.DB.prepare(
        "UPDATE orders SET payment_status = 'paid', status = 'confirmed' WHERE id = ? AND payment_status != 'paid'"
      ).bind(orderId).run();
      // AWB-ul Sameday se introduce MANUAL din panoul de admin după expediere.
    }
  }

  return json({ received: true });
}

// ────────────────────────────────────────────────────────────────
// Sameday (autentificare, lockere, AWB)
// ────────────────────────────────────────────────────────────────

function samedayBase(env) {
  return (env.SAMEDAY_API_URL || 'https://api.sameday.ro').replace(/\/$/, '');
}

async function getSamedayToken(env) {
  const cached = await kvGet(env, 'sameday_token');
  if (cached) return cached;

  if (!env.SAMEDAY_USERNAME || !env.SAMEDAY_PASSWORD) {
    throw new Error('Credențiale Sameday lipsă (SAMEDAY_USERNAME / SAMEDAY_PASSWORD)');
  }
  const resp = await fetch(samedayBase(env) + '/api/authenticate', {
    method: 'POST',
    headers: {
      'X-Auth-Username': env.SAMEDAY_USERNAME,
      'X-Auth-Password': env.SAMEDAY_PASSWORD,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'remember_me=true'
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.token) {
    throw new Error('Autentificare Sameday eșuată: ' + (data.message || resp.status));
  }
  // Token valid ~24h; îl ținem 23h ca margine de siguranță.
  await kvSet(env, 'sameday_token', data.token, 23 * 60 * 60 * 1000);
  return data.token;
}

// Apel autenticat la Sameday cu reîncercare la token expirat (401).
async function samedayFetch(env, path, init = {}, retry = true) {
  const token = await getSamedayToken(env);
  const resp = await fetch(samedayBase(env) + path, {
    ...init,
    headers: { ...(init.headers || {}), 'X-Auth-Token': token }
  });
  if (resp.status === 401 && retry) {
    await kvSet(env, 'sameday_token', '', 1); // invalidează
    return samedayFetch(env, path, init, false);
  }
  return resp;
}

async function getLockers(env) {
  const cached = await kvGet(env, 'sameday_lockers');
  if (cached) { try { return JSON.parse(cached); } catch { /* refetch */ } }

  const all = [];
  let page = 1;
  const maxPages = 10;
  while (page <= maxPages) {
    const resp = await samedayFetch(env, `/api/client/lockers?page=${page}&countPerPage=500`);
    if (!resp.ok) throw new Error('Sameday lockere: HTTP ' + resp.status);
    const data = await resp.json();
    const list = Array.isArray(data) ? data
      : (data.data && (data.data.lockers || data.data)) || data.lockers || [];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const l of list) all.push(normalizeLocker(l));
    const totalPages = data.pages || data.totalPages || (data.data && data.data.pages);
    if (totalPages && page >= totalPages) break;
    if (list.length < 500) break;
    page++;
  }

  const lockers = all.filter(l => l.id);
  if (lockers.length) {
    await kvSet(env, 'sameday_lockers', JSON.stringify(lockers), 12 * 60 * 60 * 1000);
  }
  return lockers;
}

function normalizeLocker(l) {
  const addr = l.address;
  return {
    id: l.id || l.lockerId,
    name: l.name || l.lockerName || '',
    county: l.county || l.countyName || (addr && addr.county) || '',
    city: l.city || l.cityName || (addr && addr.city) || '',
    address: (typeof addr === 'string' ? addr : (addr && (addr.address || addr.street))) || l.addressText || '',
    postalCode: l.postalCode || l.zipCode || (addr && addr.postalCode) || '',
    lat: l.lat || l.latitude || (addr && addr.latitude) || null,
    lng: l.lng || l.longitude || (addr && addr.longitude) || null
  };
}

// Creează AWB pentru o comandă (idempotent: nu recreează dacă există deja).
async function tryCreateAwbForOrder(env, orderId) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!o) throw new Error('Comanda nu există');
  if (o.awb_number) return { awbNumber: o.awb_number, already: true };
  if (o.product !== 'fizica') return { skipped: 'produs digital' };

  try {
    const result = await createSamedayAwb(env, o);
    await env.DB.prepare(
      "UPDATE orders SET awb_number = ?, awb_cost = ?, awb_error = NULL, status = 'shipped' WHERE id = ?"
    ).bind(result.awbNumber, result.awbCost || null, orderId).run();
    return result;
  } catch (err) {
    await env.DB.prepare('UPDATE orders SET awb_error = ? WHERE id = ?')
      .bind(String(err.message || err).slice(0, 800), orderId).run();
    throw err;
  }
}

async function createSamedayAwb(env, order) {
  if (!env.SAMEDAY_PICKUP_POINT_ID) throw new Error('SAMEDAY_PICKUP_POINT_ID lipsește');
  if (!env.SAMEDAY_SERVICE_ID) throw new Error('SAMEDAY_SERVICE_ID lipsește');
  if (!order.locker_id) throw new Error('Comanda nu are locker Easybox');

  const isCod = order.payment_status === 'cod';
  const weight = Number(env.SAMEDAY_PACKAGE_WEIGHT || 1);

  const body = {
    pickupPoint: Number(env.SAMEDAY_PICKUP_POINT_ID),
    packageType: 0,            // 0 = colet
    packageNumber: 1,
    packageWeight: weight,
    service: Number(env.SAMEDAY_SERVICE_ID),
    awbPayment: 1,             // 1 = expeditorul plătește transportul
    cashOnDelivery: isCod ? Number(order.total) : 0,
    insuredValue: 0,
    thirdPartyPickup: 0,
    parcels: [{ weight, width: 25, length: 35, height: 5 }],
    awbRecipient: {
      name: order.customer_name,
      phoneNumber: order.customer_phone,
      personType: 0,           // 0 = persoană fizică
      email: order.customer_email,
      postalCode: order.shipping_postal || '',
      county: order.shipping_region || order.shipping_city || '',
      city: order.shipping_city || '',
      address: order.shipping_address || order.locker_name || 'Easybox'
    },
    // Livrare Easybox: locker-ul de destinație (Out Of Home, last mile).
    oohLastMile: Number(order.locker_id)
  };
  if (env.SAMEDAY_CONTACT_PERSON_ID) body.contactPerson = Number(env.SAMEDAY_CONTACT_PERSON_ID);

  const resp = await samedayFetch(env, '/api/awb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm(body)
  });
  const raw = await resp.text();
  let data; try { data = JSON.parse(raw); } catch { data = {}; }
  if (!resp.ok) {
    throw new Error('Sameday AWB (HTTP ' + resp.status + '): ' + (data.message || raw).slice(0, 400));
  }
  return {
    awbNumber: data.awbNumber || data.awbCursor || (data.parcels && data.parcels[0] && data.parcels[0].awbNumber),
    awbCost: data.awbCost || data.cost || null
  };
}

// ────────────────────────────────────────────────────────────────
// Admin
// ────────────────────────────────────────────────────────────────

async function handleListOrders(request, env) {
  const unauth = requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  const { results } = await env.DB.prepare(`
    SELECT
      id, created_at, status,
      product, product_label AS productLabel, quantity, unit_price AS unitPrice,
      shipping_price AS shippingPrice, total, currency,
      shipping_method AS shippingMethod, payment_method AS paymentMethod,
      payment_status AS paymentStatus,
      customer_name AS customerName, customer_email AS customerEmail, customer_phone AS customerPhone,
      shipping_country, shipping_address, shipping_city, shipping_postal, shipping_region,
      locker_id, locker_name,
      awb_number AS awbNumber, awb_cost AS awbCost, awb_error AS awbError,
      notes
    FROM orders
    ORDER BY created_at DESC
    LIMIT 1000
  `).all();

  return json({ success: true, orders: results || [] });
}

async function handleUpdateOrder(request, env, id) {
  const unauth = requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: 'Invalid JSON' }, 400); }

  const allowedStatuses = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  if (!allowedStatuses.includes(body.status)) return json({ success: false, error: 'Status invalid' }, 400);

  const result = await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(body.status, id).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  }
  return json({ success: true });
}

async function handleDeleteOrder(request, env, id) {
  const unauth = requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  const result = await env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  }
  return json({ success: true });
}

// Salvare MANUALĂ a AWB-ului (introdus de admin după expediere la curier).
// Body: { awbNumber: "..." }. Setează numărul și marchează comanda ca expediată.
async function handleGenerateAwb(request, env, id) {
  const unauth = requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: 'Invalid JSON' }, 400); }

  const awb = (body.awbNumber == null ? '' : String(body.awbNumber)).trim();
  if (!awb) return json({ success: false, error: 'Introdu numărul AWB' }, 400);
  if (awb.length > 100) return json({ success: false, error: 'AWB prea lung' }, 400);

  const result = await env.DB.prepare(
    "UPDATE orders SET awb_number = ?, awb_error = NULL, status = 'shipped' WHERE id = ?"
  ).bind(awb, id).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  }
  return json({ success: true, awbNumber: awb });
}

// Diagnostic: testează autentificarea Sameday și ajută la descoperirea ID-urilor
// (servicii și puncte de ridicare) necesare în config.
async function handleSamedayDiagnostics(request, env) {
  const unauth = requireAdmin(request, env);
  if (unauth) return unauth;

  const out = { base: samedayBase(env), auth: false };
  try {
    await getSamedayToken(env);
    out.auth = true;
  } catch (err) {
    out.authError = err.message || String(err);
    return json({ success: true, diagnostics: out });
  }
  // Servicii
  try {
    const r = await samedayFetch(env, '/api/client/services?page=1&countPerPage=100');
    const d = await r.json();
    const list = (d.data && (d.data.services || d.data)) || d.services || d;
    out.services = (Array.isArray(list) ? list : []).map(s => ({
      id: s.id, name: s.name, code: s.serviceCode || s.code, deliveryType: s.deliveryType
    }));
  } catch (err) { out.servicesError = err.message || String(err); }
  // Puncte de ridicare
  try {
    const r = await samedayFetch(env, '/api/client/pickup-points?page=1&countPerPage=100');
    const d = await r.json();
    const list = (d.data && (d.data.pickupPoints || d.data)) || d.pickupPoints || d;
    out.pickupPoints = (Array.isArray(list) ? list : []).map(p => ({
      id: p.id, name: p.alias || p.name, city: p.city, defaultContactPerson: p.defaultPickupPoint
    }));
  } catch (err) { out.pickupPointsError = err.message || String(err); }

  return json({ success: true, diagnostics: out });
}
