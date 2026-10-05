/**
 * Connections are the outside services a workflow can act through, and each one offers
 * operations. An `action` step names an operation (`use: "slack.sendMessage"`) and fills its
 * inputs (`with`). This module is the registry: what each operation accepts and records. It is
 * pure, so the designer prompt, the workflow checker, and the studio UI all read it. How the
 * operations execute lives in `src/connection-runner.ts`.
 */

/**
 * The kinds of value an operation input takes.
 *
 * - `text`: any text; templates render to a string.
 * - `datetime`: an ISO 8601 date and time.
 * - `duration`: `"30 minutes"`, `"1 hour"`, and so on.
 * - `person`: one `{{ref}}` to an entity with an email field, or an email address.
 * - `people`: a list of `person` values.
 * - `url`: a literal public HTTPS URL. Templates aren't allowed.
 * - `json`: any JSON; a single `{{ref}}` passes its value through unchanged.
 */
export type InputType = "text" | "datetime" | "duration" | "person" | "people" | "url" | "json";

export interface OperationInput {
  readonly name: string;
  readonly type: InputType;
  readonly required: boolean;
  readonly description: string;
}

export interface Operation {
  /** `<connection>.<operation>`, as written in an action step's `use`. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly inputs: ReadonlyArray<OperationInput>;
  /** What the step records under `steps.<id>`, for the designer. */
  readonly records: string;
  /** The fields of that record a later step may read. */
  readonly recordFields: ReadonlyArray<string>;
}

export interface Connection {
  readonly id: string;
  readonly title: string;
  /**
   * Simulated connections have no credentials yet. Their operations succeed without contacting
   * the service and record what they would have sent.
   */
  readonly simulated: boolean;
  readonly operations: ReadonlyArray<Operation>;
}

const input = (
  name: string,
  type: InputType,
  description: string,
  required = true,
): OperationInput => ({ name, type, required, description });

export const connections: ReadonlyArray<Connection> = [
  {
    id: "email",
    title: "Email",
    simulated: true,
    operations: [
      {
        id: "email.send",
        title: "Send an email",
        description: "Sends an email.",
        inputs: [
          input("to", "person", "The recipient"),
          input("subject", "text", "Subject line"),
          input("body", "text", "Plain-text body"),
        ],
        records: '{"messageId": string}',
        recordFields: ["messageId"],
      },
    ],
  },
  {
    id: "slack",
    title: "Slack",
    simulated: true,
    operations: [
      {
        id: "slack.sendMessage",
        title: "Send a Slack message",
        description: "Sends a direct message to a person, or posts to a channel such as #general.",
        inputs: [
          input("to", "text", 'A person ({{ref}} or email) or a channel ("#team")'),
          input("text", "text", "The message"),
        ],
        records: '{"channel": string, "ts": string}',
        recordFields: ["channel", "ts"],
      },
    ],
  },
  {
    id: "calendar",
    title: "Calendar",
    simulated: true,
    operations: [
      {
        id: "calendar.findTimes",
        title: "Find open times",
        description:
          "Finds times when every attendee is free, from `after` onwards, during working hours.",
        inputs: [
          input("attendees", "people", "Who must be free"),
          input("after", "datetime", "Earliest start"),
          input("duration", "duration", "Length of the meeting"),
        ],
        records: '{"times": [datetime, ...]}, the first few open start times',
        recordFields: ["times"],
      },
      {
        id: "calendar.createEvent",
        title: "Create a calendar event",
        description: "Adds an event to the attendees' calendars, optionally repeating weekly.",
        inputs: [
          input("title", "text", "Event title"),
          input("attendees", "people", "Who is invited"),
          input("start", "datetime", "Start time"),
          input("duration", "duration", "Length, such as 30 minutes"),
          input("description", "text", "Notes shown on the event", false),
          input("repeat", "text", '"weekly" for a recurring event', false),
        ],
        records: '{"eventId": string, "start": datetime}',
        recordFields: ["eventId", "start"],
      },
    ],
  },
  {
    id: "http",
    title: "HTTP",
    simulated: false,
    operations: [
      {
        id: "http.post",
        title: "POST to a webhook",
        description:
          "POSTs JSON to a public HTTPS URL. Without a body, it sends the run's subject and step records. Delivery is at least once.",
        inputs: [
          input("url", "url", "The endpoint. Never invent one; ask for it."),
          input("body", "json", "The JSON to send", false),
        ],
        records: '{"status": number, "body": string}',
        recordFields: ["status", "body"],
      },
    ],
  },
];

export const operations: ReadonlyArray<Operation> = connections.flatMap(
  (connection) => connection.operations,
);

export const findOperation = (id: string) => operations.find((operation) => operation.id === id);

export const connectionOf = (operationId: string) =>
  connections.find((connection) => operationId.startsWith(`${connection.id}.`));
