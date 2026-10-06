import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import { LoadCatalog, LoadUsage } from "./command.ts";
import { Activity, Catalog, Confirmation, Editor, Model, Usage } from "./model.ts";
import type { UpdateReturn } from "./update.ts";

const usageFor = (maybeTemplateName: Option.Option<string>) =>
  Option.match(maybeTemplateName, {
    onNone: () => Usage.NotSelected(),
    onSome: (name) => Usage.Loading({ name }),
  });

export const loadUsage = (maybeTemplateName: Option.Option<string>) =>
  Option.match(maybeTemplateName, {
    onNone: () => [],
    onSome: (name) => [LoadUsage({ name })],
  });

export const init = (maybeTemplateName: Option.Option<string>): UpdateReturn => ({
  model: Model.make({
    maybeTemplateName,
    catalog: Catalog.Loading(),
    usage: usageFor(maybeTemplateName),
    editor: Editor.Closed(),
    confirmation: Confirmation.None(),
    activity: Activity.Idle(),
  }),
  commands: [LoadCatalog(), ...loadUsage(maybeTemplateName)],
});

/** Opens the template the URL selects. Any open form closes; the last notice stays. */
export const reflectUrl = (
  model: Model,
  maybeTemplateName: Option.Option<string>,
): UpdateReturn => {
  if (Equal.equals(model.maybeTemplateName, maybeTemplateName)) {
    return { model };
  }
  return {
    model: modifyFields(model, {
      maybeTemplateName: () => maybeTemplateName,
      usage: () => usageFor(maybeTemplateName),
      editor: () => Editor.Closed(),
      confirmation: () => Confirmation.None(),
    }),
    commands: loadUsage(maybeTemplateName),
  };
};
