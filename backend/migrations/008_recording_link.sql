-- A recording is made on one channel of a call; the call history joins it through the call's linked id (shared by
-- every channel of the call), so a call that was answered by an agent behind a queue or ring group still finds it.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS linked_id TEXT;
CREATE INDEX IF NOT EXISTS recordings_linked_idx ON recordings (linked_id);
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS caller_name TEXT;
