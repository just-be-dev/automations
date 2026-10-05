import type { Update } from "foldkit";
import { LoadOverview } from "./command.ts";
import type { Message } from "./message.ts";
import { Launch, Listing, Model } from "./model.ts";

/** Opens the overview. `session` must differ from every earlier overview's. */
export const init = (session: number): Update.Return<Model, Message> => ({
  model: Model.make({ session, poll: 0, listing: Listing.Loading(), launch: Launch.Idle() }),
  commands: [LoadOverview({ session, poll: 0 })],
});
