import * as Cloudflare from "alchemy/Cloudflare";

/** Shared D1 database for the automation index and entity store. */
export const AutomationsDatabase = Cloudflare.D1.Database("AutomationsDatabase", {
  migrations: "./migrations",
});
