import { Runtime } from "foldkit";
import { Message, Model, init, update, view } from "./main.ts";
import { Flags, loadFlags } from "./theme.ts";
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
