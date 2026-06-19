-- YESHUA — schema D1 (instalare nouă)

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',

  product         TEXT NOT NULL,
  product_label   TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_price      INTEGER NOT NULL,
  shipping_price  INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'RON',

  shipping_method TEXT,
  payment_method  TEXT,
  payment_status  TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | cod | failed
  stripe_session_id TEXT,

  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,

  shipping_country TEXT,
  shipping_address TEXT,
  shipping_city    TEXT,
  shipping_postal  TEXT,
  shipping_region  TEXT,

  -- Livrare Easybox (Sameday)
  locker_id        TEXT,
  locker_name      TEXT,

  -- AWB Sameday
  awb_number       TEXT,
  awb_cost         REAL,
  awb_error        TEXT,

  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email   ON orders(customer_email);

-- Cache pentru token-ul Sameday și lista de lockere
CREATE TABLE IF NOT EXISTS app_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER             -- epoch ms; NULL = fără expirare
);
