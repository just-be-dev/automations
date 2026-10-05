-- The list behind `GET /api/automations`. Each automation's data stays in its own Durable Object;
-- this table only records which automations exist.
CREATE TABLE automations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX automations_by_updated_at ON automations (updated_at DESC);
