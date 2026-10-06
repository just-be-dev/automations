/** Handles the studio's JSON API requests and supplies labelled entities for choosing run subjects. */
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { EntityRecord, EntityType } from "../entities.ts";

const ErrorResponse = Schema.Struct({ error: Schema.String });

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String,
}) {}

export type RequestMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Sends `body` as JSON with `method` and decodes the reply. `/api` failures carry `{ error }`. */
export const sendJson = Effect.fn("studio.sendJson")(function* <T, E>(
  method: RequestMethod,
  url: string,
  schema: Schema.Codec<T, E>,
  body?: unknown,
) {
  const client = yield* HttpClient.HttpClient;
  const bare = HttpClientRequest.make(method)(url);
  const httpRequest = body === undefined ? bare : yield* HttpClientRequest.bodyJson(bare, body);
  const response = yield* client.execute(httpRequest);
  const data = yield* response.json;
  if (response.status < 200 || response.status >= 300) {
    const failure = yield* Schema.decodeUnknownEffect(ErrorResponse)(data);
    return yield* new ApiError({ message: failure.error });
  }
  return yield* Schema.decodeUnknownEffect(schema)(data);
});

/** GETs `url`, or POSTs `body` as JSON, and decodes the reply. */
export const requestJson = <T, E>(url: string, schema: Schema.Codec<T, E>, body?: unknown) =>
  sendJson(body === undefined ? "GET" : "POST", url, schema, body);

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Unexpected error";

/** An entity a run can be started for, labelled by its type's title field. */
export const SubjectOption = Schema.Struct({ id: Schema.String, title: Schema.String });
export type SubjectOption = typeof SubjectOption.Type;

const entityTitle = (entity: EntityRecord, titleField: string) => {
  const title = entity.data[titleField];
  return Predicate.isString(title) && title.trim() !== "" ? title : entity.id;
};

/** The entities of `entityType` to pick a run's subject from, with the type's label. */
export const loadSubjectOptions = (entityType: string) =>
  Effect.all(
    [
      requestJson("/api/entities/types", Schema.Array(EntityType)),
      requestJson(`/api/entities/${entityType}`, Schema.Array(EntityRecord)),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([types, entities]) => {
      const { label, titleField } = Option.match(
        Array.findFirst(types, (type) => type.name === entityType),
        {
          onNone: () => ({ label: entityType, titleField: "name" }),
          onSome: (type) => ({ label: type.label, titleField: type.title }),
        },
      );
      return {
        label,
        subjects: Array.map(entities, (entity): SubjectOption => ({
          id: entity.id,
          title: entityTitle(entity, titleField),
        })),
      };
    }),
  );
