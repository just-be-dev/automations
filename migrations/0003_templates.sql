-- Templates: approved wording that action steps fill in (see `Template` in src/templates.ts).
-- `definition` holds the template as JSON. The `EntityStore` D1 layer reads and writes it.
CREATE TABLE templates (
  name TEXT PRIMARY KEY NOT NULL,
  definition TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Two welcome emails, so the designer has a template for engineers and one for everyone else.
INSERT INTO templates (name, definition, updated_at) VALUES
  ('engineering_welcome_email', '{"name":"engineering_welcome_email","label":"Engineering welcome email","description":"The standard welcome email for new engineers: software engineers, engineering managers, and other engineering roles. Send it to the new hire before they start.","slots":[{"name":"hire","label":"New hire","type":"ref","to":"employee"},{"name":"manager","label":"Their manager","type":"ref","to":"employee"}],"content":{"subject":"Welcome to engineering, {{hire.name}}","body":"Hi {{hire.name}},\n\nWelcome to the engineering team! You start on {{hire.start_date}}, and {{manager.name}} will be your manager.\n\nIn your first week you''ll set up your development environment, pair with a teammate on a small change, and ship it to production. {{manager.name}} will walk you through the engineering handbook on day one.\n\nIf you have questions before you start, write to {{manager.email}}.\n\nSee you soon!"}}', 0),
  ('welcome_email', '{"name":"welcome_email","label":"Welcome email","description":"The standard welcome email for any new hire without a more specific welcome template. Send it to the new hire before they start.","slots":[{"name":"hire","label":"New hire","type":"ref","to":"employee"}],"content":{"subject":"Welcome aboard, {{hire.name}}","body":"Hi {{hire.name}},\n\nWe''re excited to have you join us as {{hire.role}} on {{hire.start_date}}.\n\nOn your first day you''ll meet your manager, {{hire.manager}}, get your accounts set up, and spend some time getting to know the team.\n\nIf you have any questions before then, just reply to this email.\n\nSee you soon!"}}', 0);
