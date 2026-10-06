-- PBX configuration (extensions, paging groups, trunks, routes), call detail records and the
-- apply log. The backend renders this into Asterisk configuration; Asterisk never reads the
-- database directly.

-- ------------------------------------------------------------------ extensions
CREATE TABLE IF NOT EXISTS extensions (
  id             BIGSERIAL PRIMARY KEY,
  number         TEXT        NOT NULL,
  display_name   TEXT        NOT NULL,
  -- NULL only for the two seeded extensions until the backend fills them from the environment.
  secret         TEXT,
  phone_secret   TEXT,
  webrtc_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
  phone_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  allow_outbound BOOLEAN     NOT NULL DEFAULT FALSE,
  outbound_cid   TEXT,
  enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT extensions_number_format CHECK (number ~ '^[0-9]{3,6}$'),
  CONSTRAINT extensions_name_len CHECK (char_length(display_name) BETWEEN 1 AND 40),
  CONSTRAINT extensions_outbound_cid_format CHECK (outbound_cid IS NULL OR outbound_cid ~ '^\+?[0-9]{3,20}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS extensions_number_key ON extensions (number);
DROP TRIGGER IF EXISTS extensions_set_updated_at ON extensions;
CREATE TRIGGER extensions_set_updated_at BEFORE UPDATE ON extensions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO extensions (number, display_name, allow_outbound)
VALUES ('1001', 'Office', FALSE), ('1002', 'Warehouse', FALSE)
ON CONFLICT (number) DO NOTHING;

-- Users may now be bound to any extension; deleting an extension unassigns its user.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_extension_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_extension_fk') THEN
    ALTER TABLE users ADD CONSTRAINT users_extension_fk
      FOREIGN KEY (extension) REFERENCES extensions (number) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

-- --------------------------------------------------------------- paging groups
CREATE TABLE IF NOT EXISTS paging_groups (
  id         BIGSERIAL PRIMARY KEY,
  number     TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paging_groups_number_format CHECK (number ~ '^[0-9]{3,6}$'),
  CONSTRAINT paging_groups_name_len CHECK (char_length(name) BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX IF NOT EXISTS paging_groups_number_key ON paging_groups (number);
DROP TRIGGER IF EXISTS paging_groups_set_updated_at ON paging_groups;
CREATE TRIGGER paging_groups_set_updated_at BEFORE UPDATE ON paging_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS paging_group_members (
  group_id     BIGINT NOT NULL REFERENCES paging_groups (id) ON DELETE CASCADE,
  extension_id BIGINT NOT NULL REFERENCES extensions (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, extension_id)
);

INSERT INTO paging_groups (number, name) VALUES ('700', 'Page All'), ('701', 'Page Office'), ('702', 'Page Warehouse')
ON CONFLICT (number) DO NOTHING;

INSERT INTO paging_group_members (group_id, extension_id)
SELECT g.id, e.id FROM paging_groups g JOIN extensions e
  ON (g.number = '700' AND e.number IN ('1001', '1002'))
  OR (g.number = '701' AND e.number = '1001')
  OR (g.number = '702' AND e.number = '1002')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------- trunks
CREATE TABLE IF NOT EXISTS trunks (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,           -- slug used in Asterisk object names
  display_name     TEXT        NOT NULL,
  kind             TEXT        NOT NULL DEFAULT 'provider',  -- provider | pbx | gateway (UI hint only)
  auth_mode        TEXT        NOT NULL,           -- register | ip
  host             TEXT        NOT NULL,
  port             INTEGER     NOT NULL DEFAULT 5060,
  transport        TEXT        NOT NULL DEFAULT 'udp',
  username         TEXT,
  password         TEXT,
  auth_username    TEXT,
  from_user        TEXT,
  from_domain      TEXT,
  register_expiry  INTEGER     NOT NULL DEFAULT 3600,
  codecs           TEXT[]      NOT NULL DEFAULT ARRAY['ulaw', 'alaw'],
  dtmf_mode        TEXT        NOT NULL DEFAULT 'rfc4733',
  max_channels     INTEGER     NOT NULL DEFAULT 0, -- 0 = unlimited
  caller_id_num    TEXT,
  caller_id_name   TEXT,
  match_ips        TEXT[]      NOT NULL DEFAULT '{}',
  -- Where calls that match no inbound route go: { "type": "extension", "value": "1001" } or NULL (reject).
  inbound_default  JSONB,
  qualify          BOOLEAN     NOT NULL DEFAULT TRUE,
  enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trunks_name_format CHECK (name ~ '^[a-z][a-z0-9_-]{1,23}$'),
  CONSTRAINT trunks_kind_check CHECK (kind IN ('provider', 'pbx', 'gateway')),
  CONSTRAINT trunks_auth_mode_check CHECK (auth_mode IN ('register', 'ip')),
  CONSTRAINT trunks_transport_check CHECK (transport IN ('udp', 'tcp')),
  CONSTRAINT trunks_port_check CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT trunks_dtmf_check CHECK (dtmf_mode IN ('rfc4733', 'inband', 'info', 'auto')),
  CONSTRAINT trunks_channels_check CHECK (max_channels BETWEEN 0 AND 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS trunks_name_key ON trunks (name);
DROP TRIGGER IF EXISTS trunks_set_updated_at ON trunks;
CREATE TRIGGER trunks_set_updated_at BEFORE UPDATE ON trunks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------- inbound routes
CREATE TABLE IF NOT EXISTS inbound_routes (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT        NOT NULL,
  did             TEXT        NOT NULL,            -- digits, +digits, an Asterisk _pattern, or * (any)
  trunk_id        BIGINT REFERENCES trunks (id) ON DELETE CASCADE,  -- NULL = every trunk
  dest_type       TEXT        NOT NULL,
  dest_value      TEXT        NOT NULL DEFAULT '',
  cid_name_prefix TEXT,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inbound_name_len CHECK (char_length(name) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_routes_did_key ON inbound_routes (COALESCE(trunk_id, 0), did);
DROP TRIGGER IF EXISTS inbound_routes_set_updated_at ON inbound_routes;
CREATE TRIGGER inbound_routes_set_updated_at BEFORE UPDATE ON inbound_routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------- outbound routes
CREATE TABLE IF NOT EXISTS outbound_routes (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  patterns   TEXT[]      NOT NULL,
  strip      INTEGER     NOT NULL DEFAULT 0,
  prepend    TEXT        NOT NULL DEFAULT '',
  cid_num    TEXT,
  emergency  BOOLEAN     NOT NULL DEFAULT FALSE,   -- bypasses the per-extension outbound permission
  position   INTEGER     NOT NULL DEFAULT 0,
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbound_name_len CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT outbound_strip_check CHECK (strip BETWEEN 0 AND 20),
  CONSTRAINT outbound_prepend_format CHECK (prepend ~ '^\+?[0-9*]{0,20}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_routes_name_key ON outbound_routes (name);
DROP TRIGGER IF EXISTS outbound_routes_set_updated_at ON outbound_routes;
CREATE TRIGGER outbound_routes_set_updated_at BEFORE UPDATE ON outbound_routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS outbound_route_trunks (
  route_id BIGINT  NOT NULL REFERENCES outbound_routes (id) ON DELETE CASCADE,
  trunk_id BIGINT  NOT NULL REFERENCES trunks (id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route_id, trunk_id)
);

-- ------------------------------------------------------------ call detail records
CREATE TABLE IF NOT EXISTS cdr (
  id               BIGSERIAL PRIMARY KEY,
  unique_id        TEXT        NOT NULL,
  linked_id        TEXT,
  start_time       TIMESTAMPTZ NOT NULL,
  answer_time      TIMESTAMPTZ,
  end_time         TIMESTAMPTZ,
  src              TEXT,
  dst              TEXT,
  caller_id        TEXT,
  channel          TEXT,
  dst_channel      TEXT,
  last_app         TEXT,
  disposition      TEXT,
  duration         INTEGER     NOT NULL DEFAULT 0,
  billsec          INTEGER     NOT NULL DEFAULT 0,
  direction        TEXT        NOT NULL DEFAULT 'internal',  -- internal | inbound | outbound
  trunk            TEXT,
  hangup_cause     TEXT,
  recording_file   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cdr_unique_key ON cdr (unique_id, COALESCE(dst_channel, ''), start_time);
CREATE INDEX IF NOT EXISTS cdr_start_idx ON cdr (start_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS cdr_src_idx ON cdr (src);
CREATE INDEX IF NOT EXISTS cdr_dst_idx ON cdr (dst);
CREATE INDEX IF NOT EXISTS cdr_direction_idx ON cdr (direction, start_time DESC);
CREATE INDEX IF NOT EXISTS cdr_linked_idx ON cdr (linked_id);

-- ---------------------------------------------------------------- apply history
CREATE TABLE IF NOT EXISTS pbx_apply_log (
  id         BIGSERIAL PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok         BOOLEAN     NOT NULL,
  checksum   TEXT,
  reason     TEXT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS pbx_apply_log_at_idx ON pbx_apply_log (applied_at DESC);
