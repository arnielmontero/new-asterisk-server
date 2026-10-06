-- The dialplan marks inbound trunk calls with the number that was dialled (CDR userfield "in:<DID>"):
-- Asterisk itself reports "h" as the destination of such a record.
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS userfield TEXT;
