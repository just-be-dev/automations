import * as Option from "effect/Option";
import type { EntityRecord, EntityType } from "../../entities.ts";
import { Message, init, update, type Model } from "./main.ts";

export const employee: EntityType = {
  name: "employee",
  label: "Employee",
  title: "name",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "level", label: "Level", type: "number" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "manager", label: "Manager", type: "ref", to: "employee" },
  ],
};

export const ada: EntityRecord = {
  type: "employee",
  id: "ada",
  data: { name: "Ada Lovelace", level: 3, start_date: null, manager: "grace" },
  updatedAt: 0,
};

const applied = (start: Model, messages: ReadonlyArray<Message>) =>
  messages.reduce((current, next) => update(current, next).model, start);

export const employeesOpen = applied(init(Option.some("employee")).model, [
  Message.SucceededLoadTypes({ types: [employee] }),
  Message.SucceededLoadEntities({ type: "employee", entities: [ada] }),
]);
