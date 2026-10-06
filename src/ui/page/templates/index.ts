/**
 * Templates at `/templates`: list them, create and edit them, and see which automations use one.
 * `?template=<name>` selects a template, so the URL decides what's open and the root app passes it
 * in with `reflectUrl`.
 */
export { Model } from "./model.ts";
export { Message } from "./message.ts";
export * from "./init.ts";
export * from "./update.ts";
export * from "./command.ts";
export * from "./view.ts";
