import { inertHtml as ih } from "foldkit/html";

/** Names the view that drew an element, as `data-component`, so it can be found in devtools. */
export const componentName = (name: string) => ih.DataAttribute("component", name);
