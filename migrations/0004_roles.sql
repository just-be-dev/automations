-- Roles: named groups of people who approve the operations a workflow asks first about. Each
-- row holds the role's definition as JSON (see `Role` in src/entities.ts); members are entities
-- with an email field, by type and ID.
CREATE TABLE roles (
  name TEXT PRIMARY KEY NOT NULL,
  definition TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A starting role, so workflows have someone to ask.
INSERT INTO roles (name, definition, updated_at) VALUES (
  'people_ops',
  '{"name":"people_ops","label":"People Ops","members":[{"type":"employee","id":"grace"}]}',
  0
);
