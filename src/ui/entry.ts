/** Boots the browser application with saved preferences, routing, and the studio's fonts and styles. */
import { Runtime } from "foldkit";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
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
  init,
  update,
  view,
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  container: document.getElementById("root"),
  devTools: { Message },
});

Runtime.run(application, { flags: loadFlags });
