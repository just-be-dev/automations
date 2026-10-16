-- The studio agent's threads, per person, behind `GET /api/assistant`. Each thread's conversation
-- stays in its own Durable Object; this table only records which threads exist, their titles, and
-- which are archived.
CREATE TABLE assistant_threads (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, id)
);

CREATE INDEX assistant_threads_by_owner ON assistant_threads (owner, updated_at DESC);
