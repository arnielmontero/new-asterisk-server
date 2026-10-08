-- Conference rooms (phase C1). A room is a number people dial; options are applied per call by the dialplan.
CREATE TABLE IF NOT EXISTS conferences (
  id           BIGSERIAL PRIMARY KEY,
  number       TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  pin          TEXT,                              -- NULL = open room
  admin_pin    TEXT,                              -- NULL = nobody is a room administrator by PIN
  mute_on_join BOOLEAN     NOT NULL DEFAULT FALSE,
  max_members  INTEGER     NOT NULL DEFAULT 0,    -- 0 = no limit
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conferences_number_format CHECK (number ~ '^[0-9]{3,6}$'),
  CONSTRAINT conferences_name_len CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT conferences_pin_format CHECK (pin IS NULL OR pin ~ '^[0-9]{3,10}$'),
  CONSTRAINT conferences_admin_pin_format CHECK (admin_pin IS NULL OR admin_pin ~ '^[0-9]{3,10}$'),
  CONSTRAINT conferences_pins_differ CHECK (pin IS NULL OR admin_pin IS NULL OR pin <> admin_pin),
  CONSTRAINT conferences_max_members_check CHECK (max_members = 0 OR max_members BETWEEN 2 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS conferences_number_key ON conferences (number);
DROP TRIGGER IF EXISTS conferences_set_updated_at ON conferences;
CREATE TRIGGER conferences_set_updated_at BEFORE UPDATE ON conferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
