-- Call queues (phase B3) and their statistics.

CREATE TABLE IF NOT EXISTS queues (
  id               BIGSERIAL PRIMARY KEY,
  number           TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  strategy         TEXT        NOT NULL DEFAULT 'ringall',
  member_timeout   INTEGER     NOT NULL DEFAULT 15,   -- how long each agent's phone rings
  wrapup_secs      INTEGER     NOT NULL DEFAULT 5,    -- pause after a call before the agent is offered the next
  max_callers      INTEGER     NOT NULL DEFAULT 0,    -- 0 = unlimited
  max_wait_secs    INTEGER     NOT NULL DEFAULT 120,  -- a caller waits at most this long
  hold_when_empty  BOOLEAN     NOT NULL DEFAULT FALSE,-- let callers wait even when no agent is available
  fail_dest        JSONB,                             -- where callers go when they cannot be served (NULL = hang up)
  enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT queues_number_format CHECK (number ~ '^[0-9]{3,6}$'),
  CONSTRAINT queues_name_len CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT queues_strategy_check CHECK (strategy IN ('ringall', 'leastrecent', 'fewestcalls', 'rrmemory', 'random', 'linear')),
  CONSTRAINT queues_timeout_check CHECK (member_timeout BETWEEN 5 AND 60),
  CONSTRAINT queues_wrapup_check CHECK (wrapup_secs BETWEEN 0 AND 120),
  CONSTRAINT queues_callers_check CHECK (max_callers BETWEEN 0 AND 500),
  CONSTRAINT queues_wait_check CHECK (max_wait_secs BETWEEN 10 AND 3600)
);
CREATE UNIQUE INDEX IF NOT EXISTS queues_number_key ON queues (number);
DROP TRIGGER IF EXISTS queues_set_updated_at ON queues;
CREATE TRIGGER queues_set_updated_at BEFORE UPDATE ON queues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS queue_members (
  queue_id     BIGINT  NOT NULL REFERENCES queues (id) ON DELETE CASCADE,
  extension_id BIGINT  NOT NULL REFERENCES extensions (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queue_id, extension_id)
);

-- One row per caller that left the queue (served, abandoned or turned away), built from Asterisk's queue events.
CREATE TABLE IF NOT EXISTS queue_calls (
  id          BIGSERIAL PRIMARY KEY,
  queue       TEXT        NOT NULL,           -- queue number
  unique_id   TEXT        NOT NULL,
  caller      TEXT,
  agent       TEXT,                           -- extension number that served the call
  wait_secs   INTEGER     NOT NULL DEFAULT 0,
  talk_secs   INTEGER     NOT NULL DEFAULT 0,
  outcome     TEXT        NOT NULL,           -- answered | abandoned | timeout | unavailable | full
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT queue_calls_outcome_check CHECK (outcome IN ('answered', 'abandoned', 'timeout', 'unavailable', 'full'))
);
CREATE UNIQUE INDEX IF NOT EXISTS queue_calls_unique_key ON queue_calls (unique_id, queue);
CREATE INDEX IF NOT EXISTS queue_calls_queue_idx ON queue_calls (queue, created_at DESC);
