/** Opens the entity store at the URL's selected type and resets forms when that selection changes. */
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import { LoadEntities, LoadTypes } from "./command.ts";
import {
  Activity,
  Confirmation,
  EntityEditor,
  Model,
  Records,
  TypeEditor,
  Types,
} from "./model.ts";
import type { UpdateReturn } from "./update.ts";

const recordsFor = (maybeTypeName: Option.Option<string>) =>
  Option.match(maybeTypeName, {
    onNone: () => Records.NotSelected(),
    onSome: (type) => Records.Loading({ type }),
  });

export const loadRecords = (maybeTypeName: Option.Option<string>) =>
  Option.match(maybeTypeName, {
    onNone: () => [],
    onSome: (type) => [LoadEntities({ type })],
  });

export const init = (maybeTypeName: Option.Option<string>): UpdateReturn => ({
  model: Model.make({
    maybeTypeName,
    types: Types.Loading(),
    records: recordsFor(maybeTypeName),
    typeEditor: TypeEditor.Closed(),
    entityEditor: EntityEditor.Closed(),
    confirmation: Confirmation.None(),
    activity: Activity.Idle(),
  }),
  commands: [LoadTypes(), ...loadRecords(maybeTypeName)],
});

/** Opens the type the URL selects. Any open form closes; the last notice stays. */
export const reflectUrl = (model: Model, maybeTypeName: Option.Option<string>): UpdateReturn => {
  if (Equal.equals(model.maybeTypeName, maybeTypeName)) {
    return { model };
  }
  return {
    model: modifyFields(model, {
      maybeTypeName: () => maybeTypeName,
      records: () => recordsFor(maybeTypeName),
      typeEditor: () => TypeEditor.Closed(),
      entityEditor: () => EntityEditor.Closed(),
      confirmation: () => Confirmation.None(),
    }),
    commands: loadRecords(maybeTypeName),
  };
};
