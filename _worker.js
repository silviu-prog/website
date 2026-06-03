// YESHUA backend — handles order creation and admin management.
// Static files are served via env.ASSETS (Cloudflare Pages built-in).

export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      response = json({ success: false, error: 'server_error' }, 500);
    }
    return withSecurityHeaders(response);
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // ── API routes ──────────────────────────────────────────────
  if (url.pathname === '/api/orders' && request.method === 'POST') {
    return handleCreateOrder(request, env, ip);
  }
  if (url.pathname === '/api/admin/login' && request.method === 'POST') {
    return handleAdminLogin(request, env, ip);
  }
  if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
    return handleListOrders(request, env);
  }
  const adminOrderMatch = url.pathname.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)$/);
  if (adminOrderMatch && request.method === 'PATCH') {
    return handleUpdateOrder(request, env, adminOrderMatch[1]);
  }
  if (adminOrderMatch && request.method === 'DELETE') {
    return handleDeleteOrder(request, env, adminOrderMatch[1]);
  }

  // ── Static assets ───────────────────────────────────────────
  return env.ASSETS.fetch(request);
}

// ────────────────────────────────────────────────────────────────
// Server-authoritative pricing — never trust prices from the client.
// ────────────────────────────────────────────────────────────────
const CATALOG = {
  fizica:   { label: 'Carte fizică',  unit: 45 },
  digitala: { label: 'Carte digitală', unit: 25 }
};
const SHIPPING = {
  RO:      { method: 'Curier România',     price: 15 },
  EU:      { method: 'Curier UE',          price: 45 },
  DIGITAL: { method: 'Livrare prin email', price: 0  }
};
const CURRENCY = 'RON';

// Compute the shipping option + payment method on the server side.
function resolveShipping(product, country) {
  if (product === 'digitala') {
    return { ...SHIPPING.DIGITAL, payment: 'Transfer bancar' };
  }
  if (country === 'RO') {
    return { ...SHIPPING.RO, payment: 'Ramburs la livrare' };
  }
  return { ...SHIPPING.EU, payment: 'Transfer bancar' };
}

// ────────────────────────────────────────────────────────────────
// Security headers (applied to every response)
// ────────────────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  headers.set('Content-Security-Policy', CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// ────────────────────────────────────────────────────────────────
// Rate limiting (best-effort, in-memory per isolate).
// For robust protection, also enable Cloudflare WAF Rate Limiting Rules.
// ────────────────────────────────────────────────────────────────
const rlStore = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let entry = rlStore.get(key);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + windowMs };
    rlStore.set(key, entry);
  }
  entry.count++;
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (rlStore.size > 5000) {
    for (const [k, v] of rlStore) { if (now > v.reset) rlStore.delete(k); }
  }
  return entry.count <= max;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// Constant-time string comparison to avoid leaking match length via timing.
function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// HMAC-SHA256 keyed with the admin password — no extra secret/env needed.
// Changing the password automatically invalidates all existing sessions.
async function hmac(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return b64url(new Uint8Array(sig));
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

async function issueAdminToken(env) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${env.ADMIN_USERNAME}.${exp}`;
  const sig = await hmac(env.ADMIN_PASSWORD, payload);
  return `${payload}.${sig}`;
}

// Verifies the signed session token. Returns a 401/503 Response on failure,
// or null when the request is authenticated.
async function requireAdmin(request, env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return json({ success: false, error: 'admin_not_configured' }, 503);
  }
  const token = request.headers.get('X-Admin-Token') || '';
  const idx2 = token.lastIndexOf('.');
  const idx1 = token.lastIndexOf('.', idx2 - 1);
  if (idx1 < 0 || idx2 < 0) {
    return json({ success: false, error: 'unauthorized' }, 401);
  }
  const user = token.slice(0, idx1);
  const expStr = token.slice(idx1 + 1, idx2);
  const sig = token.slice(idx2 + 1);
  const exp = Number(expStr);

  if (user !== env.ADMIN_USERNAME || !Number.isFinite(exp) || exp < Date.now()) {
    return json({ success: false, error: 'unauthorized' }, 401);
  }
  const expected = await hmac(env.ADMIN_PASSWORD, `${user}.${expStr}`);
  if (!timingSafeEqual(sig, expected)) {
    return json({ success: false, error: 'unauthorized' }, 401);
  }
  return null;
}

function generateOrderId() {
  // 12-char human-friendly ID: YSH-XXXX-XXXX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (n) => Array.from({ length: n }, () =>
    chars[Math.floor(Math.random() * chars.length)]).join('');
  return `YSH-${part(4)}-${part(4)}`;
}

function validString(v, max = 500) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

// ────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────

async function handleAdminLogin(request, env, ip) {
  if (!rateLimit('login:' + ip, 10, 5 * 60 * 1000)) {
    return json({ success: false, error: 'too_many_attempts' }, 429);
  }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return json({ success: false, error: 'admin_not_configured' }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: 'invalid_json' }, 400); }

  const user = String(body.username || '');
  const pass = String(body.password || '');
  // Evaluate both comparisons to avoid short-circuit timing differences.
  const okUser = timingSafeEqual(user, env.ADMIN_USERNAME);
  const okPass = timingSafeEqual(pass, env.ADMIN_PASSWORD);
  if (!(okUser && okPass)) {
    return json({ success: false, error: 'unauthorized' }, 401);
  }
  const token = await issueAdminToken(env);
  return json({ success: true, token });
}

async function handleCreateOrder(request, env, ip) {
  if (!rateLimit('order:' + ip, 8, 60 * 1000)) {
    return json({ success: false, error: 'too_many_requests' }, 429);
  }
  if (!env.DB) {
    return json({ success: false, error: 'Database not configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, 400);
  }

  // ── Validate ─────────────────────────────────────────────────
  const errors = [];
  if (!CATALOG[body.product]) errors.push('Produs invalid');
  if (!body.customer || !validString(body.customer.name, 200)) errors.push('Nume invalid');
  if (!body.customer || !validString(body.customer.email, 200) || !body.customer.email.includes('@')) errors.push('Email invalid');
  if (!body.customer || !validString(body.customer.phone, 50)) errors.push('Telefon invalid');

  const sh = (body.product === 'fizica' && body.shipping) ? body.shipping : {};
  if (body.product === 'fizica') {
    if (!body.shipping) errors.push('Lipsesc datele de livrare');
    else {
      if (!validString(sh.address, 300)) errors.push('Adresa invalidă');
      if (!validString(sh.city, 100)) errors.push('Localitate invalidă');
      if (!validString(sh.postal, 30)) errors.push('Cod poștal invalid');
      if (!validString(sh.country, 5)) errors.push('Țara invalidă');
    }
  }

  // Quantity: positive integer, capped.
  let quantity = Math.floor(Number(body.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
  if (quantity > 100) quantity = 100;

  if (errors.length) return json({ success: false, error: errors.join('; ') }, 400);

  // ── Compute prices on the server — client-sent prices are ignored ──
  const product = body.product;
  const catalog = CATALOG[product];
  const country = product === 'fizica' ? String(sh.country || '') : '';
  const ship = resolveShipping(product, country);

  const unitPrice = catalog.unit;
  const shippingPrice = ship.price;
  const total = unitPrice * quantity + shippingPrice;
  const productLabel = catalog.label;
  const shippingMethod = ship.method;
  const paymentMethod = ship.payment;

  // ── Persist ──────────────────────────────────────────────────
  const id = generateOrderId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO orders (
      id, created_at, status,
      product, product_label, quantity, unit_price, shipping_price, total, currency,
      shipping_method, payment_method,
      customer_name, customer_email, customer_phone,
      shipping_country, shipping_address, shipping_city, shipping_postal, shipping_region,
      notes
    ) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, now,
    product, productLabel, quantity, unitPrice, shippingPrice, total, CURRENCY,
    shippingMethod, paymentMethod,
    body.customer.name.trim(), body.customer.email.trim().toLowerCase(), body.customer.phone.trim(),
    product === 'fizica' ? (sh.country || null) : null,
    product === 'fizica' ? (sh.address || null) : null,
    product === 'fizica' ? (sh.city || null) : null,
    product === 'fizica' ? (sh.postal || null) : null,
    product === 'fizica' ? (sh.region || null) : null,
    validString(body.notes, 2000) ? body.notes.trim() : null
  ).run();

  return json({ success: true, orderId: id, total, currency: CURRENCY });
}

async function handleListOrders(request, env) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  const { results } = await env.DB.prepare(`
    SELECT
      id, created_at, status,
      product, product_label AS productLabel, quantity, unit_price AS unitPrice,
      shipping_price AS shippingPrice, total, currency,
      shipping_method AS shippingMethod, payment_method AS paymentMethod,
      customer_name AS customerName, customer_email AS customerEmail, customer_phone AS customerPhone,
      shipping_country, shipping_address, shipping_city, shipping_postal, shipping_region,
      notes
    FROM orders
    ORDER BY created_at DESC
    LIMIT 1000
  `).all();

  return json({ success: true, orders: results || [] });
}

async function handleUpdateOrder(request, env, id) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: 'Invalid JSON' }, 400); }

  const allowedStatuses = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  if (!allowedStatuses.includes(body.status)) {
    return json({ success: false, error: 'Status invalid' }, 400);
  }

  const result = await env.DB.prepare(
    'UPDATE orders SET status = ? WHERE id = ?'
  ).bind(body.status, id).run();

  if (!result.meta || result.meta.changes === 0) {
    return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  }
  return json({ success: true });
}

async function handleDeleteOrder(request, env, id) {
  const unauth = await requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  const result = await env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  }
  return json({ success: true });
}
