import * as Array from "effect/Array";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import { componentName } from "@/lib/component";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// What a step recorded, laid out for people who don't read JSON: labelled fields, readable dates,
// lists as tags.

type JsonObject = { readonly [key: string]: Schema.Json };

/** Fields the studio already says in words, such as whether the step was simulated. */
const hiddenFields: ReadonlyArray<string> = ["simulated"];

const fieldLabels: Readonly<Record<string, string>> = {
  ts: "Sent",
  messageId: "Message ID",
  eventId: "Event ID",
  url: "Web address",
};

const sentenceCase = (key: string) => {
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** A field's name as a label: `start_date` reads "Start date". */
export const fieldLabel = (key: string) => fieldLabels[key] ?? sentenceCase(key);

const isJsonList = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is JsonObject =>
  Predicate.isObject(value) && !isJsonList(value);

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const slackTimestamp = /^\d+(\.\d+)?$/;

const formatDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** A text value as people read it: dates and times formatted, everything else as written. */
export const formatText = (key: string, text: string) => {
  if (key === "ts" && slackTimestamp.test(text)) {
    return formatTime(Number(text) * 1000);
  }
  if (isoDate.test(text)) {
    return formatDate(text);
  }
  if (isoDateTime.test(text) && !Number.isNaN(Date.parse(text))) {
    return formatTime(Date.parse(text));
  }
  return text;
};

const recordNoneView = <M>(h: HtmlBuilder<M>) =>
  h.span([componentName("record-none"), h.Class("text-muted-foreground")], ["None"]);

const isPrimitive = (value: Schema.Json) => !Predicate.isObject(value);

const primitiveText = (key: string, value: Schema.Json) =>
  Predicate.isString(value)
    ? formatText(key, value)
    : Predicate.isNumber(value)
      ? value.toLocaleString("en-US")
      : Predicate.isBoolean(value)
        ? value
          ? "Yes"
          : "No"
        : "None";

const recordValueView = <M>(
  key: string,
  value: Schema.Json,
  isExpanded: boolean,
  h: HtmlBuilder<M>,
): Html => {
  if (value === null) {
    return recordNoneView(h);
  }
  if (isJsonList(value)) {
    return recordListView(key, value, isExpanded, h);
  }
  if (isJsonObject(value)) {
    return h.div(
      [componentName("record-value"), h.Class("border-l pl-3")],
      [recordFieldsView(value, isExpanded, h)],
    );
  }
  return h.span(
    [
      componentName("record-value"),
      h.Class(
        cn(
          "break-words whitespace-pre-wrap",
          !isExpanded && Predicate.isString(value) && "line-clamp-3",
        ),
      ),
    ],
    [primitiveText(key, value)],
  );
};

const recordListView = <M>(
  key: string,
  items: ReadonlyArray<Schema.Json>,
  isExpanded: boolean,
  h: HtmlBuilder<M>,
): Html => {
  if (Array.isReadonlyArrayEmpty(items)) {
    return recordNoneView(h);
  }
  if (Array.every(items, isPrimitive)) {
    return h.ul(
      [componentName("record-list"), h.Class("flex flex-wrap gap-1")],
      Array.map(items, (item) =>
        h.li(
          [h.Class("rounded-[4px] bg-chip px-1.5 py-0.5 text-xs break-all")],
          [primitiveText(key, item)],
        ),
      ),
    );
  }
  return h.ol(
    [componentName("record-list"), h.Class("flex flex-col gap-2")],
    Array.map(items, (item) =>
      h.li([h.Class("border-l pl-3")], [recordValueView(key, item, isExpanded, h)]),
    ),
  );
};

const recordFieldsView = <M>(record: JsonObject, isExpanded: boolean, h: HtmlBuilder<M>): Html =>
  Array.match(
    Array.filter(Object.entries(record), ([key]) => !Array.contains(hiddenFields, key)),
    {
      onEmpty: () =>
        h.p(
          [componentName("record-fields"), h.Class("text-muted-foreground")],
          ["Nothing to show"],
        ),
      onNonEmpty: (fields) =>
        h.dl(
          [componentName("record-fields"), h.Class("flex flex-col gap-2.5")],
          Array.map(fields, ([key, value]) =>
            h.keyed("div")(
              key,
              [
                h.Class(
                  "flex flex-col gap-0.5 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3",
                ),
              ],
              [
                h.dt([h.Class("text-xs text-muted-foreground sm:pt-px")], [fieldLabel(key)]),
                h.dd([h.Class("min-w-0")], [recordValueView(key, value, isExpanded, h)]),
              ],
            ),
          ),
        ),
    },
  );

/** A step's record as fields and values. A bare answer, such as an agent's text, shows as is. */
export const recordView = <M>(record: Schema.Json, isExpanded: boolean, h: HtmlBuilder<M>) =>
  isJsonObject(record)
    ? recordFieldsView(record, isExpanded, h)
    : recordValueView("", record, isExpanded, h);
