-- entity-store now holds entity types and entities, and roles are gone, so the tables that held
-- them here go, with their data. Entity subscriptions stay: they record which type each saved
-- workflow watches.
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS entity_types;
DROP TABLE IF EXISTS roles;

-- The two seeded welcome emails fill their `hire` slot with an `employee`, a type automations no
-- longer provides, so they would be invalid on every stage.
DELETE FROM templates WHERE name IN ('engineering_welcome_email', 'welcome_email');
