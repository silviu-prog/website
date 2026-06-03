// YESHUA backend — handles order creation and admin management.
// Static files are served via env.ASSETS (Cloudflare Pages built-in).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── API routes ──────────────────────────────────────────────
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      return handleCreateOrder(request, env);
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
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function requireAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  // Token format: "username:password"
  const [user, pass] = token.split(':');
  const okUser = env.ADMIN_USERNAME && user === env.ADMIN_USERNAME;
  const okPass = env.ADMIN_PASSWORD && pass === env.ADMIN_PASSWORD;
  if (!okUser || !okPass) {
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

async function handleCreateOrder(request, env) {
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
  if (!['fizica', 'digitala'].includes(body.product)) errors.push('Produs invalid');
  if (!body.customer || !validString(body.customer.name, 200)) errors.push('Nume invalid');
  if (!body.customer || !validString(body.customer.email, 200) || !body.customer.email.includes('@')) errors.push('Email invalid');
  if (!body.customer || !validString(body.customer.phone, 50)) errors.push('Telefon invalid');
  if (body.product === 'fizica') {
    if (!body.shipping) errors.push('Lipsesc datele de livrare');
    else {
      if (!validString(body.shipping.address, 300)) errors.push('Adresa invalidă');
      if (!validString(body.shipping.city, 100)) errors.push('Localitate invalidă');
      if (!validString(body.shipping.postal, 30)) errors.push('Cod poștal invalid');
      if (!validString(body.shipping.country, 5)) errors.push('Țara invalidă');
    }
  }
  const unitPrice = Number(body.unitPrice);
  const shippingPrice = Number(body.shippingPrice);
  const total = Number(body.total);
  if (!Number.isFinite(unitPrice) || !Number.isFinite(shippingPrice) || !Number.isFinite(total)) {
    errors.push('Prețuri invalide');
  }
  if (errors.length) return json({ success: false, error: errors.join('; ') }, 400);

  // ── Persist ──────────────────────────────────────────────────
  const id = generateOrderId();
  const now = new Date().toISOString();
  const sh = body.shipping || {};

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
    body.product, body.productLabel || '', body.quantity || 1, unitPrice, shippingPrice, total, body.currency || 'RON',
    body.shippingMethod || '', body.paymentMethod || '',
    body.customer.name.trim(), body.customer.email.trim().toLowerCase(), body.customer.phone.trim(),
    sh.country || null, sh.address || null, sh.city || null, sh.postal || null, sh.region || null,
    body.notes || null
  ).run();

  return json({ success: true, orderId: id });
}

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
  const unauth = requireAdmin(request, env);
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
  const unauth = requireAdmin(request, env);
  if (unauth) return unauth;
  if (!env.DB) return json({ success: false, error: 'Database not configured' }, 503);

  const result = await env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id).run();
  if (!result.meta || result.meta.changes === 0) {
    return json({ success: false, error: 'Comanda nu a fost găsită' }, 404);
  }
  return json({ success: true });
}
