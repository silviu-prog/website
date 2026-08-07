-- Migrare pentru baze existente: adaugă coloanele necesare mementourilor
-- de plată trimise clienților cu comenzi neplătite.
--
-- Rulează cu:
--   wrangler d1 execute <DB> --remote --file=migrations/0003_reminders.sql

ALTER TABLE orders ADD COLUMN reminder_sent_at  TEXT;
ALTER TABLE orders ADD COLUMN reminder_count    INTEGER NOT NULL DEFAULT 0;
