import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Option, Schema, SchemaIssue } from "effect";

/**
 * A settings file could not be read, decoded, or replaced. The message names
 * the file and the first invalid field, never its contents.
 */
export class JsonFileError extends Schema.TaggedError<JsonFileError>()("JsonFileError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const firstIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Reads and decodes a JSON file, or `None` when it does not exist.
 * Decoding failures name the first invalid top-level field, falling back to `label`.
 */
export const readJsonFile = Effect.fnUntraced(function* <T, E>(
  path: string,
  schema: Schema.Codec<T, E>,
  label: string,
): Effect.fn.Return<Option.Option<T>, JsonFileError> {
  const file = Bun.file(path);

  const exists = yield* Effect.tryPromise({
    try: () => file.exists(),
    catch: (cause) => new JsonFileError({ path, message: `Could not read ${path}`, cause }),
  });

  if (!exists) return Option.none();

  const text = yield* Effect.tryPromise({
    try: () => file.text(),
    catch: (cause) => new JsonFileError({ path, message: `Could not read ${path}`, cause }),
  });

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.map(Option.some),
    Effect.mapError((cause) => {
      const [key] = firstIssue(cause.issue).issues[0]?.path ?? [];

      return new JsonFileError({
        path,
        message: `Invalid ${key === undefined ? label : String(key)} in ${path}`,
        cause,
      });
    }),
  );
});

/**
 * Atomically replaces a JSON file, creating its directory when needed.
 */
export const writeJsonFile = Effect.fnUntraced(function* <T, E>(
  path: string,
  schema: Schema.Codec<T, E>,
  value: T,
): Effect.fn.Return<void, JsonFileError> {
  const encoded = yield* Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) => new JsonFileError({ path, message: `Could not encode ${path}`, cause }),
    ),
  );

  const temp = `${path}.${crypto.randomUUID()}.tmp`;

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(temp, `${JSON.stringify(encoded, null, 2)}\n`);
      await rename(temp, path);
    },
    catch: (cause) => new JsonFileError({ path, message: `Could not write ${path}`, cause }),
  }).pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        const file = Bun.file(temp);

        if (await file.exists()) await file.delete();
      }),
    ),
  );
});
