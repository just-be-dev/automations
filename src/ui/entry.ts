/** Boots the browser application with saved preferences, routing, and the studio's fonts and styles. */
import { Runtime } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { stripUrl } from "./base-path.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscription.ts";
import { Flags, loadFlags } from "./theme.ts";
import { update } from "./update/index.ts";
import { view } from "./view/index.ts";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  Flags,
  // NOTE: Under the hub, the studio is served below a base path (base-path.ts); routes see paths
  // without it.
  init: (flags, url) => init(flags, stripUrl(url)),
  update,
  view,
  subscriptions,
  routing: {
    onUrlRequest: (request) =>
      Message.ClickedLink({
        request: UrlRequest.match(request, {
          Internal: ({ url }) => UrlRequest.Internal({ url: stripUrl(url) }),
          External: () => request,
        }),
      }),
    onUrlChange: (url) => Message.ChangedUrl({ url: stripUrl(url) }),
  },
  container: document.getElementById("root"),
  devTools: { Message },
});

Runtime.run(application, { flags: loadFlags });
