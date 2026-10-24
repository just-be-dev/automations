/** Keeps the hub shell's sidebar in step with the studio, and turns its action buttons into Messages. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { type HubNav, hubActionMessage, hubNavOf, publishHubNav } from "./hub-nav.ts";
import type { Message } from "./message.ts";
import type { Model } from "./model.ts";

const actionOf = (event: unknown): Option.Option<string> =>
  event instanceof CustomEvent &&
  typeof event.detail === "object" &&
  event.detail !== null &&
  typeof event.detail.action === "string"
    ? Option.some(event.detail.action)
    : Option.none();

const sameNav = (self: { readonly nav: HubNav }, that: { readonly nav: HubNav }) =>
  JSON.stringify(self.nav) === JSON.stringify(that.nav);

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  /** Publishes the nav again only when it changes, compared by its JSON. */
  hubNav: entry(
    { nav: Schema.Any },
    {
      modelToDependencies: (model) => ({ nav: hubNavOf(model) }),
      keepAliveEquivalence: sameNav,
      dependenciesToStream: ({ nav }) =>
        Stream.fromEffect(Effect.sync(() => publishHubNav(nav))).pipe(Stream.drain),
    },
  ),
  hubAction: Subscription.persistentEntry(
    Stream.fromEventListener(window, "hub:action").pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(Option.toArray(Option.flatMap(actionOf(event), hubActionMessage))),
      ),
    ),
  ),
}));
