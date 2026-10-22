/**
 * Lets `alchemy dev` here bind the entity-store that `alchemy dev` serves in its own checkout.
 *
 * automations finds entity-store's Api Worker through an Alchemy reference, which reads that
 * stack's state. Under `alchemy dev` each checkout keeps its state in its own `.alchemy/state`,
 * so this links entity-store's into this checkout's. Set `ENTITY_STORE_DIR` (in `.env`) to the
 * entity-store checkout, and start its `alchemy dev` first, on the same stage. `mise run dev`
 * runs this before it starts.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";

const STACK = "entity-store";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const dir = process.env["ENTITY_STORE_DIR"]?.trim();
if (dir === undefined || dir === "") {
  fail(
    "Set ENTITY_STORE_DIR in .env to your entity-store checkout, and run `alchemy dev` there first. See docs/development.md#running-entity-store-alongside.",
  );
}
const stage = process.env["STAGE"]?.trim() || `dev_${process.env["USER"] ?? ""}`;
const source = resolve(dir ?? "", ".alchemy/state", STACK);
if (!existsSync(resolve(source, stage))) {
  fail(
    `No entity-store state for stage ${stage} in ${source}. Run \`alchemy dev\` in ${dir} first, on stage ${stage}.`,
  );
}
const target = resolve(".alchemy/state", STACK);
const link = lstatSync(target, { throwIfNoEntry: false });
if (link !== undefined) {
  if (!link.isSymbolicLink()) {
    fail(`${target} exists and isn't a link; move it away to use ${source}.`);
  }
  if (resolve(readlinkSync(target)) === source) {
    process.exit(0);
  }
  fail(`${target} links to ${readlinkSync(target)}, not ${source}; remove it to relink.`);
}
mkdirSync(resolve(".alchemy/state"), { recursive: true });
symlinkSync(source, target, "dir");
console.log(`Linked entity-store's ${stage} state from ${source}`);
