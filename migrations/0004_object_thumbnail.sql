-- Sidecar poster metadata for completed objects.
-- The thumbnail media itself lives in Telegram as a separate small document;
-- these columns only reference it and must stay nullable for legacy objects.
ALTER TABLE objects ADD COLUMN thumbnail_message_id TEXT;
ALTER TABLE objects ADD COLUMN thumbnail_mime TEXT;
ALTER TABLE objects ADD COLUMN thumbnail_size INTEGER;
ALTER TABLE objects ADD COLUMN thumbnail_sha256 TEXT;
