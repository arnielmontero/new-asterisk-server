-- Voicemail and call recording (phase B4).

ALTER TABLE extensions ADD COLUMN IF NOT EXISTS voicemail_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS voicemail_greeting_id BIGINT REFERENCES prompts (id) ON DELETE SET NULL;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS voicemail_max_secs INTEGER NOT NULL DEFAULT 120;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS record_calls BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'extensions_vm_secs_check') THEN
    ALTER TABLE extensions ADD CONSTRAINT extensions_vm_secs_check CHECK (voicemail_max_secs BETWEEN 10 AND 600);
  END IF;
END $$;

ALTER TABLE trunks ADD COLUMN IF NOT EXISTS record_calls BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per message left; the audio is /pbx-media/voicemail/<file>.
CREATE TABLE IF NOT EXISTS voicemails (
  id            BIGSERIAL PRIMARY KEY,
  extension     TEXT        NOT NULL,
  caller        TEXT,
  file          TEXT        NOT NULL,
  duration_secs INTEGER     NOT NULL DEFAULT 0,
  heard_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT voicemails_file_format CHECK (file ~ '^[A-Za-z0-9._-]+\.wav$')
);
CREATE UNIQUE INDEX IF NOT EXISTS voicemails_file_key ON voicemails (file);
CREATE INDEX IF NOT EXISTS voicemails_ext_idx ON voicemails (extension, created_at DESC);

-- One row per recorded call, joined to the call history through the caller channel's unique id.
CREATE TABLE IF NOT EXISTS recordings (
  id            BIGSERIAL PRIMARY KEY,
  unique_id     TEXT        NOT NULL,
  file          TEXT        NOT NULL,
  caller        TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  size_bytes    BIGINT      NOT NULL DEFAULT 0,
  duration_secs INTEGER     NOT NULL DEFAULT 0,
  finished      BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT recordings_file_format CHECK (file ~ '^[A-Za-z0-9._-]+\.wav$')
);
CREATE UNIQUE INDEX IF NOT EXISTS recordings_unique_key ON recordings (unique_id);
CREATE INDEX IF NOT EXISTS recordings_started_idx ON recordings (started_at DESC);
