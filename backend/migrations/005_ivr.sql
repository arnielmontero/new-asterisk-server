-- Audio prompts, announcements and IVR menus (phase B2).

-- A prompt is a recording stored as /pbx-media/prompts/<id>.wav (8 kHz mono 16-bit, what Asterisk plays natively).
CREATE TABLE IF NOT EXISTS prompts (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  duration_ms INTEGER     NOT NULL,
  size_bytes  INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prompts_name_len CHECK (char_length(name) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompts_name_key ON prompts (name);

-- Plays a prompt, then continues to another destination (or hangs up). "We are closed" messages, notices.
CREATE TABLE IF NOT EXISTS announcements (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  prompt_id  BIGINT      NOT NULL REFERENCES prompts (id) ON DELETE RESTRICT,
  next_dest  JSONB,
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcements_name_len CHECK (char_length(name) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS announcements_name_key ON announcements (name);
DROP TRIGGER IF EXISTS announcements_set_updated_at ON announcements;
CREATE TRIGGER announcements_set_updated_at BEFORE UPDATE ON announcements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ivrs (
  id                   BIGSERIAL PRIMARY KEY,
  number               TEXT        NOT NULL,
  name                 TEXT        NOT NULL,
  prompt_id            BIGINT REFERENCES prompts (id) ON DELETE RESTRICT,
  timeout_secs         INTEGER     NOT NULL DEFAULT 6,    -- how long to wait for a key after the prompt
  max_repeats          INTEGER     NOT NULL DEFAULT 2,    -- times the menu is played before giving up
  options              JSONB       NOT NULL DEFAULT '[]', -- [{ "digit": "1", "dest": { "type": ..., "value": ... } }]
  fail_dest            JSONB,                             -- after the last repeat (NULL = hang up)
  allow_extension_dial BOOLEAN     NOT NULL DEFAULT FALSE,-- callers may dial an extension number directly
  enabled              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ivrs_number_format CHECK (number ~ '^[0-9]{3,6}$'),
  CONSTRAINT ivrs_name_len CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT ivrs_timeout_check CHECK (timeout_secs BETWEEN 3 AND 30),
  CONSTRAINT ivrs_repeats_check CHECK (max_repeats BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX IF NOT EXISTS ivrs_number_key ON ivrs (number);
DROP TRIGGER IF EXISTS ivrs_set_updated_at ON ivrs;
CREATE TRIGGER ivrs_set_updated_at BEFORE UPDATE ON ivrs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
