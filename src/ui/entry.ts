import { Runtime } from "foldkit";
import { Message, Model, init, update, view } from "./main.ts";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
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

Runtime.run(application);
