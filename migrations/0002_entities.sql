-- The entities automations act on, for the `EntityStore` D1 layer (src/entity-store-d1.ts).
-- `entity_types` holds each type's definition as JSON (see `EntityType` in src/entities.ts), and
-- `entities` holds the records, with `ref` fields storing the target entity's ID.
CREATE TABLE entity_types (
  name TEXT PRIMARY KEY NOT NULL,
  definition TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE entities (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (type, id)
);

-- Which entity type each automation's saved workflow watches. Written on save, read when an
-- entity changes.
CREATE TABLE entity_subscriptions (
  automation_id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL
);

CREATE INDEX entity_subscriptions_by_type ON entity_subscriptions (entity_type);

-- A starting type and two people, so onboarding-style automations have something to act on.
INSERT INTO entity_types (name, definition, updated_at) VALUES (
  'employee',
  '{"name":"employee","label":"Employee","title":"name","fields":[{"name":"name","label":"Name","type":"text"},{"name":"email","label":"Email","type":"text"},{"name":"role","label":"Role","type":"text"},{"name":"start_date","label":"Start date","type":"date"},{"name":"manager","label":"Manager","type":"ref","to":"employee"}]}',
  0
);

INSERT INTO entities (type, id, data, updated_at) VALUES
  ('employee', 'grace', '{"name":"Grace Hopper","email":"grace@example.com","role":"Engineering manager","start_date":"2019-03-04","manager":null}', 0),
  ('employee', 'ada', '{"name":"Ada Lovelace","email":"ada@example.com","role":"Software engineer","start_date":null,"manager":"grace"}', 0);
