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

  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,

  shipping_country TEXT,
  shipping_address TEXT,
  shipping_city    TEXT,
  shipping_postal  TEXT,
  shipping_region  TEXT,

  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email   ON orders(customer_email);
