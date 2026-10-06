-- Call flow (phase B1): ring groups, time conditions, and per-extension do-not-disturb / forwarding.
-- Destinations are stored as JSON { "type": "...", "value": "..." } everywhere they are not a plain column pair.

ALTER TABLE extensions ADD COLUMN IF NOT EXISTS dnd BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS fwd_all JSONB;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS fwd_busy JSONB;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS fwd_noanswer JSONB;
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS noanswer_secs INTEGER NOT NULL DEFAULT 25;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'extensions_noanswer_secs_check') THEN
    ALTER TABLE extensions ADD CONSTRAINT extensions_noanswer_secs_check CHECK (noanswer_secs BETWEEN 5 AND 120);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ring_groups (
  id         BIGSERIAL PRIMARY KEY,
  number     TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  strategy   TEXT        NOT NULL DEFAULT 'ringall',  -- ringall | sequential
  ring_secs  INTEGER     NOT NULL DEFAULT 20,         -- ringall: total; sequential: per member
  fail_dest  JSONB,                                   -- where an unanswered call goes (NULL = hang up)
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ring_groups_number_format CHECK (number ~ '^[0-9]{3,6}$'),
  CONSTRAINT ring_groups_name_len CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT ring_groups_strategy_check CHECK (strategy IN ('ringall', 'sequential')),
  CONSTRAINT ring_groups_secs_check CHECK (ring_secs BETWEEN 5 AND 120)
);
CREATE UNIQUE INDEX IF NOT EXISTS ring_groups_number_key ON ring_groups (number);
DROP TRIGGER IF EXISTS ring_groups_set_updated_at ON ring_groups;
CREATE TRIGGER ring_groups_set_updated_at BEFORE UPDATE ON ring_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ring_group_members (
  group_id     BIGINT  NOT NULL REFERENCES ring_groups (id) ON DELETE CASCADE,
  extension_id BIGINT  NOT NULL REFERENCES extensions (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, extension_id)
);

CREATE TABLE IF NOT EXISTS time_conditions (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  timezone      TEXT        NOT NULL DEFAULT 'UTC',
  -- [{ "days": ["mon","tue"], "from": "09:00", "to": "17:00" }]  (the "open" periods)
  rules         JSONB       NOT NULL DEFAULT '[]',
  -- [{ "month": 12, "day": 25, "name": "Christmas" }]  (closed all day, wins over rules)
  holidays      JSONB       NOT NULL DEFAULT '[]',
  match_dest    JSONB       NOT NULL,                 -- during the open periods
  nomatch_dest  JSONB       NOT NULL,                 -- otherwise
  override      TEXT        NOT NULL DEFAULT 'auto',  -- auto | open | closed (manual switch)
  enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT time_conditions_name_len CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT time_conditions_override_check CHECK (override IN ('auto', 'open', 'closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS time_conditions_name_key ON time_conditions (name);
DROP TRIGGER IF EXISTS time_conditions_set_updated_at ON time_conditions;
CREATE TRIGGER time_conditions_set_updated_at BEFORE UPDATE ON time_conditions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
