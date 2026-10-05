-- Users, audit log and the helpers they need. Written to be repeat-safe.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL,
  extension     TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  token_version INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator', 'user')),
  CONSTRAINT users_extension_check CHECK (extension IS NULL OR extension IN ('1001', '1002')),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (username);
-- One browser client per extension: a second user cannot be bound to the same extension.
CREATE UNIQUE INDEX IF NOT EXISTS users_extension_key ON users (extension) WHERE extension IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role_active_idx ON users (role, is_active);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  username    TEXT,
  action      TEXT        NOT NULL,
  target      TEXT,
  ip_address  TEXT,
  status      TEXT        NOT NULL,
  details     JSONB,
  CONSTRAINT audit_status_check CHECK (status IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs ("timestamp" DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_username_idx ON audit_logs (username);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs (user_id);

-- Audit records are append-only. The single permitted change is the foreign key
-- nulling itself when its user is deleted (the username snapshot is kept).
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND (NEW.id, NEW."timestamp", NEW.username, NEW.action, NEW.target, NEW.ip_address, NEW.status, NEW.details)
         IS NOT DISTINCT FROM
         (OLD.id, OLD."timestamp", OLD.username, OLD.action, OLD.target, OLD.ip_address, OLD.status, OLD.details)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
