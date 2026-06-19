-- Migrare pentru baze existente: adaugă coloanele necesare plății Stripe
-- și livrării Easybox / AWB Sameday.
--
-- Rulează cu:
--   wrangler d1 execute <DB> --remote --file=migrations/0002_stripe_sameday.sql
-- (SQLite ignoră ALTER-ul dacă rulezi de două ori? NU — așa că rulează o singură dată.)

ALTER TABLE orders ADD COLUMN payment_status   TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN stripe_session_id TEXT;
ALTER TABLE orders ADD COLUMN locker_id         TEXT;
ALTER TABLE orders ADD COLUMN locker_name       TEXT;
ALTER TABLE orders ADD COLUMN awb_number        TEXT;
ALTER TABLE orders ADD COLUMN awb_cost          REAL;
ALTER TABLE orders ADD COLUMN awb_error         TEXT;

CREATE TABLE IF NOT EXISTS app_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
